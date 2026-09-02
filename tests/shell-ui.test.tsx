/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import RoomApp from '../apps/web/src/App';

/**
 * The shell: what a URL means, and whether a person can find their way without being told.
 */
const identity=(companies:unknown[])=>({
  user:{id:'u1',email:'sam@example.com',display_name:'Sam Okonkwo'},companies});
const workspace=[{company_id:'c1',company_name:'Okonkwo Labs',principal_id:'p1',display_name:'Sam Okonkwo'}];
const room={room_id:'r1',name:'Rate-limit policy',project_id:'j1',project_name:'Rate-limit policy'};

function backend({me,rooms=[],agents=[]}:{me:unknown|null;rooms?:unknown[];agents?:unknown[]}){
  vi.stubGlobal('fetch',vi.fn(async(url:any)=>{
    const at=String(url);
    const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
    if(at.includes('/v1/auth/me'))return me?json(me):json({error:{code:'unauthenticated'}},401);
    if(at.includes('/rooms'))return json({rooms});
    if(at.includes('/agents'))return json({agents});
    return json({});
  }));
}

beforeEach(()=>{history.replaceState({},'','/')});
afterEach(()=>{cleanup();vi.unstubAllGlobals()});

describe('What the root URL means',()=>{
  it('greets a stranger with a way in, not a broken room link',async()=>{
    backend({me:null});
    render(<RoomApp/>);
    expect(await screen.findByRole('heading',{name:'Multiplayer AI'})).toBeVisible();
    expect(screen.getByRole('button',{name:/Create account/})).toBeVisible();
    expect(screen.getByRole('button',{name:'Sign in'})).toBeVisible();
    // The old failure mode: the root falling through to the room route.
    expect(screen.queryByText(/Room link incomplete/)).not.toBeInTheDocument();
  });

  /* Signing in used to land on the create-a-room screen, so every new account began by making a
     room it did not want — including people who had only been invited to somebody else's. Home is
     the destination; creating a room is one of three things a person may then choose. */
  it('lands someone with no workspace on Home rather than making them create a room',async()=>{
    backend({me:identity([])});
    render(<RoomApp/>);
    expect(await screen.findByRole('heading',{name:/Nothing has been created for you/})).toBeVisible();
    expect(screen.getByRole('button',{name:'Create room'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Join room'})).toBeVisible();
    expect(screen.getByRole('link',{name:'Connect existing agent'})).toBeVisible();
    // Nothing was made on the way here.
    expect(screen.queryByRole('heading',{name:/Bring your agents into one shared workspace/})).toBeNull();
  });

  it('lands someone with a workspace on Home',async()=>{
    backend({me:identity(workspace),rooms:[room]});
    render(<RoomApp/>);
    expect(await screen.findByRole('heading',{name:'Okonkwo Labs'})).toBeVisible();
    expect(screen.getByRole('button',{name:/Rate-limit policy/})).toBeVisible();
  });
});

describe('Home',()=>{
  it('says what to do when there is nothing yet, rather than looking broken',async()=>{
    backend({me:identity(workspace)});
    render(<RoomApp/>);
    await screen.findByRole('heading',{name:'Okonkwo Labs'});
    expect(screen.getByText(/No rooms yet/)).toBeVisible();
    expect(screen.getByText(/Multiplayer AI does not run agents for you/)).toBeVisible();
    expect(screen.getByRole('button',{name:/Create room/})).toBeVisible();
    expect(screen.getByRole('button',{name:/Connect an existing agent/})).toBeVisible();
  });

  it('shows an agent’s real state and where it actually works',async()=>{
    backend({me:identity(workspace),rooms:[room],agents:[
      {agent_id:'a1',principal_id:'pa',display_name:'Research agent',status:'active',owner_display_name:null,
       connector:{enrolled:true,presence:'connected',runtime_status:'idle',last_seen_at:null},rooms:[{room_id:'r1',name:'Rate-limit policy'}]},
      {agent_id:'a2',principal_id:'pb',display_name:'Drafting agent',status:'active',owner_display_name:null,
       connector:{enrolled:false,presence:'never',runtime_status:null,last_seen_at:null},rooms:null},
    ]});
    render(<RoomApp/>);
    await screen.findByRole('heading',{name:'Okonkwo Labs'});
    const connected=screen.getByText('Research agent').closest('li')!;
    expect(within(connected).getByText('Connected')).toBeVisible();
    expect(within(connected).getByText('Rate-limit policy')).toBeVisible();
    // Never connected, and in no room: both said plainly rather than guessed at.
    const fresh=screen.getByText('Drafting agent').closest('li')!;
    expect(within(fresh).getByText('Not connected yet')).toBeVisible();
    expect(within(fresh).getByText('No room yet')).toBeVisible();
  });

  it('does not put every agent in a new room by default',async()=>{
    backend({me:identity(workspace),agents:[
      {agent_id:'a1',principal_id:'pa',display_name:'Research agent',status:'active',owner_display_name:null,
       connector:{enrolled:false,presence:'never',runtime_status:null,last_seen_at:null},rooms:null},
    ]});
    render(<RoomApp/>);
    await screen.findByRole('heading',{name:'Okonkwo Labs'});
    fireEvent.click(screen.getByRole('button',{name:/Create room/}));
    // Choosing is the point: nothing is ticked for you.
    const choice=await screen.findByRole('checkbox',{name:'Research agent'});
    expect(choice).not.toBeChecked();
    expect(screen.getByText(/A room can start empty/)).toBeVisible();
  });
});

describe('Finding your way',()=>{
  it('offers Home, the rooms you have, and the way out from every signed-in page',async()=>{
    backend({me:identity(workspace),rooms:[room]});
    render(<RoomApp/>);
    await screen.findByRole('heading',{name:'Okonkwo Labs'});
    expect(screen.getByRole('button',{name:/Okonkwo Labs/})).toBeVisible();

    fireEvent.click(screen.getByRole('button',{name:'Rooms'}));
    expect(await screen.findByRole('menuitem',{name:/Rate-limit policy/})).toBeVisible();

    fireEvent.click(screen.getByRole('button',{name:'Account'}));
    expect(await screen.findByRole('menuitem',{name:'Settings'})).toBeVisible();
    expect(screen.getByRole('menuitem',{name:'Sign out'})).toBeVisible();
  });

  it('shows settings with who you are and how agents get connected',async()=>{
    backend({me:identity(workspace),rooms:[room]});
    history.replaceState({},'','/settings');
    render(<RoomApp/>);
    expect(await screen.findByRole('heading',{name:'Settings'})).toBeVisible();
    expect(screen.getByText('sam@example.com')).toBeVisible();
    expect(screen.getByText(/Multiplayer AI for Mac/)).toBeVisible();
    expect(screen.getByRole('button',{name:'Sign out'})).toBeVisible();
    // There is one product now. Naming a separate Connector here would send somebody looking
    // for a second thing to install that has not existed since this became one application.
    expect(document.body.textContent).not.toMatch(/Multiplayer AI Connector/i);
    // Deliberately not here yet.
    for(const absent of [/billing/i,/members/i,/notification/i,/API key/i])
      expect(document.body.textContent).not.toMatch(absent);
  });

  it('sends a signed-out visitor on a deep page back to the front door',async()=>{
    backend({me:null});
    history.replaceState({},'','/settings');
    render(<RoomApp/>);
    await waitFor(()=>expect(location.pathname).toBe('/'));
  });
});
