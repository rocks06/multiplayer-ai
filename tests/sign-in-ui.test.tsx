/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';

const identity={
  user:{id:'00000000-0000-4000-8000-000000000001',email:'rocco@example.com',display_name:'Rocco Donadon'},
  companies:[{company_id:'00000000-0000-4000-8000-000000000002',company_name:'Acme',principal_id:'00000000-0000-4000-8000-000000000003',display_name:'Rocco Donadon'}],
};

/** The module spends a link at import time, so each case imports it fresh at a chosen URL. */
async function mount(url:string,onAuthenticated?:(to:string)=>void,onNavigate?:(to:string)=>void){
  history.replaceState({},'',url);
  vi.resetModules();
  const {default:SignIn}=await import('../apps/web/src/SignIn');
  return render(<SignIn onAuthenticated={onAuthenticated} onNavigate={onNavigate}/>);
}

describe('Sign in',()=>{
  let replaced:string[];

  beforeEach(()=>{
    replaced=[];
    sessionStorage.clear();
  });
  afterEach(()=>{cleanup();vi.unstubAllGlobals();vi.restoreAllMocks()});

  const stubFetch=(handler:(url:string,init?:RequestInit)=>Response)=>
    vi.stubGlobal('fetch',vi.fn(async(url:any,init?:RequestInit)=>handler(String(url),init)));
  const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

  it('asks for an email when nobody is signed in',async()=>{
    stubFetch(()=>json({error:{code:'unauthenticated'}},401));
    await mount('/signin');
    expect(await screen.findByRole('heading',{name:'Sign in'})).toBeVisible();
    expect(screen.getByLabelText('Email')).toBeVisible();
  });

  it('never reveals whether an address has an account',async()=>{
    stubFetch(url=>url.includes('/sign-in-links')?json({status:'accepted'}):json({error:{}},401));
    await mount('/signin');
    fireEvent.change(await screen.findByLabelText('Email'),{target:{value:'stranger@example.com'}});
    fireEvent.click(screen.getByRole('button',{name:'Email me a sign-in link'}));
    // The same wording regardless of whether the account exists.
    expect(await screen.findByRole('heading',{name:'Link issued'})).toBeVisible();
    expect(screen.getByText(/If/)).toHaveTextContent('If stranger@example.com has an account');
  });

  it('spends a link from the address bar and returns to where the person was heading',async()=>{
    sessionStorage.setItem('mpai:after-sign-in','/rooms/company/room');
    stubFetch(url=>url.includes('/auth/sessions')?json(identity):json({error:{}},401));
    await mount('/signin?token=mpsi_good',to=>replaced.push(to));

    await waitFor(()=>expect(replaced).toEqual(['/rooms/company/room']));
    // The link leaves the address bar, so sharing or bookmarking the URL cannot replay it.
    expect(window.location.search).toBe('');
    expect(sessionStorage.getItem('mpai:after-sign-in')).toBeNull();
  });

  it('sends you to Home when there was no intended destination',async()=>{
    stubFetch(url=>url.includes('/auth/sessions')?json(identity):json({error:{}},401));
    await mount('/signin?token=mpsi_good',to=>replaced.push(to));
    /* Home, not room creation. Signing in used to land on the create-a-room screen, so every
       account — including people invited to somebody else's room — began by making a room they
       did not want. Creating one is a thing a person chooses to do. */
    await waitFor(()=>expect(replaced).toEqual(['/home']));
  });

  it('explains a spent or expired link instead of failing silently',async()=>{
    stubFetch(url=>url.includes('/auth/sessions')?json({error:{code:'sign_in_invalid'}},401):json({error:{}},401));
    await mount('/signin?token=mpsi_spent');
    expect(await screen.findByRole('heading',{name:'That link no longer works'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Request a new link'})).toBeEnabled();
  });

  it('honours an existing session rather than asking twice',async()=>{
    stubFetch(url=>url.includes('/auth/me')?json(identity):json({error:{}},401));
    await mount('/signin',to=>replaced.push(to));
    await waitFor(()=>expect(replaced).toEqual(['/home']));
    expect(screen.queryByLabelText('Email')).toBeNull();
  });

  /* Somebody who just signed out has an account. The door is Sign in; making a new account is a
     link beside it, and the screen says the account and its workspaces are exactly where they were. */
  it('offers creating an account as a way round sign-in, not instead of it',async()=>{
    stubFetch(()=>json({error:{code:'unauthenticated'}},401));
    const went:string[]=[];
    await mount('/signin',undefined,to=>went.push(to));
    expect(await screen.findByRole('heading',{name:'Sign in'})).toBeVisible();
    expect(screen.queryByRole('heading',{name:/Create your account/})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Create an account'}));
    expect(went).toEqual(['/signup']);
  });

  it('says, once, that signing out left the account and its workspaces alone',async()=>{
    sessionStorage.setItem('mpai:signed-out','1');
    stubFetch(()=>json({error:{code:'unauthenticated'}},401));
    await mount('/signin');
    expect(await screen.findByText(/signed out\. Your account and your workspaces are unchanged/)).toBeVisible();
    expect(sessionStorage.getItem('mpai:signed-out')).toBeNull();
    // Not a second time: it describes what just happened, not a standing condition.
    cleanup();
    await mount('/signin');
    expect(await screen.findByRole('heading',{name:'Sign in'})).toBeVisible();
    expect(screen.queryByText(/Your account and your workspaces are unchanged/)).not.toBeInTheDocument();
  });

  it('renders the ways in the server accepts, with the emailed link as the fallback that is always there',async()=>{
    const {offeredSignInMethods}=await import('../apps/web/src/api');
    expect(offeredSignInMethods(['email_link'])).toEqual(['email_link']);
    // A passkey the server offers but this build cannot do is not shown half-built.
    expect(offeredSignInMethods(['passkey','email_link'])).toEqual(['email_link']);
    // Once a build supports one, it goes first and the link stays underneath.
    expect(offeredSignInMethods(['passkey','email_link'],new Set(['passkey','email_link']))).toEqual(['passkey','email_link']);
    // Nothing usable from the server still leaves a way in.
    expect(offeredSignInMethods(undefined)).toEqual(['email_link']);
    expect(offeredSignInMethods(['unknown'])).toEqual(['email_link']);
  });
});
