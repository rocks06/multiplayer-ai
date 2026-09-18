import {useEffect,useRef,useState,type FormEvent} from 'react';
import {currentIdentity,redeemSignInToken,requestSignInLink,signInDelivery,signInMethods,takeSignedOutNotice,
  type SignInDelivery,type SignInMethod,type SignedInIdentity} from './api';
import {rememberAcross} from './pending-invite';

const INTENT_KEY='mpai:after-sign-in';

/* A link in the address bar is spent once, here, at module load: it leaves the URL
   immediately so a shared or bookmarked link cannot replay it, and the redemption is a single
   module-scoped promise rather than per-mount work, so a remount attaches to the same result
   instead of racing it or discarding it. */
/* The token may arrive in either half of the URL, and which one is not this page's choice.

   A link built for a browser carries it in the fragment, deliberately: a fragment is never sent to
   a server, so it stays out of host logs and out of reach of a corporate scanner that fetches the
   URL before its owner clicks — and a scanner that follows a query-string magic link spends it.
   Reading only the query string is why an invited person's link established no session here at
   all: the token was sitting in the hash, three characters away, being ignored. */
const tokenFromLocation=()=>{
  const fragment=new URLSearchParams(String(location.hash||'').replace(/^#/,'')).get('token');
  return fragment||new URLSearchParams(location.search).get('token');
};

const redemption=(()=>{
  const token=tokenFromLocation();
  if(!token)return null;
  history.replaceState({},'',location.pathname);
  return redeemSignInToken(token).then(
    identity=>({ok:true as const,identity}),
    ()=>({ok:false as const}),
  );
})();

/** Remember where someone was heading so signing in returns them there. */
export function rememberIntent(path:string){rememberAcross.write(INTENT_KEY,path)}
/** Set the ordinary post-auth destination without replacing a more specific flow such as an invite. */
export function rememberDefaultIntent(path:string){if(!rememberAcross.read(INTENT_KEY))rememberAcross.write(INTENT_KEY,path)}
function takeIntent(){const value=rememberAcross.read(INTENT_KEY);rememberAcross.forget(INTENT_KEY);return value}

type Phase=
 |{step:'checking'}
 |{step:'email'}
 |{step:'issued';email:string}
 |{step:'redeeming'}
 |{step:'link_failed'};

/** A real navigation by default: authenticating changes what every request can see, so the
 *  destination should mount once, cleanly, with the session already set. */
const hardNavigate=(to:string)=>{location.replace(to)};

/**
 * The front door, for people who already have an account — which, after signing out, is
 * everybody who sees it. Creating an account is one link away for the ones who do not.
 *
 * Methods are rendered from the list the server declares, most preferred first. Today that is the
 * emailed link alone; a passkey slots in above it without this screen changing shape, and the link
 * stays underneath as the way in that works anywhere.
 */
export default function SignIn({onAuthenticated=hardNavigate,onNavigate=hardNavigate}:{
  onAuthenticated?:(to:string)=>void;onNavigate?:(to:string)=>void}={}){
  const [phase,setPhase]=useState<Phase>({step:'checking'});
  // Read once, on arrival: said on the screen that follows signing out, and not again.
  const [signedOut]=useState(()=>takeSignedOutNotice());
  const [methods,setMethods]=useState<SignInMethod[]>(['email_link']);
  useEffect(()=>{void signInMethods().then(setMethods)},[]);
  const [email,setEmail]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  // Assume real delivery until told otherwise: claiming an email was sent when none was is the
  // worse of the two mistakes, and the developer note is the one that has to be earned.
  const [delivery,setDelivery]=useState<SignInDelivery>('resend');
  const emailField=useRef<HTMLInputElement>(null);
  useEffect(()=>{void signInDelivery().then(setDelivery)},[]);

  // A link in the address bar is redeemed immediately; otherwise an existing session is
  // honoured rather than asking someone to sign in twice.
  useEffect(()=>{
    let alive=true;
    const settle=(identity:SignedInIdentity)=>{
      if(!alive)return;
      const intent=takeIntent();
      // Invite/room intent wins. Ordinary authentication always lands on Home and never creates
      // or pressures the person to create a workspace, room, or agent.
      onAuthenticated(intent??'/home');
    };
    if(redemption){
      setPhase({step:'redeeming'});
      void redemption.then(result=>{
        if(!alive)return;
        if(result.ok)return settle(result.identity);
        setPhase({step:'link_failed'});
      });
    }else{
      void currentIdentity().then(identity=>{
        if(!alive)return;
        if(identity)return settle(identity);
        setPhase({step:'email'});
      }).catch(()=>{if(alive)setPhase({step:'email'})});
    }
    return()=>{alive=false};
  },[onAuthenticated]);

  useEffect(()=>{if(phase.step==='email')emailField.current?.focus()},[phase.step]);

  const submit=async(event:FormEvent)=>{
    event.preventDefault();
    const address=email.trim();
    if(!address)return;
    setBusy(true);setError('');
    try{
      await requestSignInLink(address);
      setPhase({step:'issued',email:address});
    }catch(problem){setError((problem as Error).message)}
    finally{setBusy(false)}
  };

  return <main className="auth">
    <div className="auth-panel">
      <div className="brand-mark" aria-hidden="true">M</div>

      {phase.step==='checking'&&<p className="auth-quiet" role="status">Checking your session…</p>}

      {phase.step==='redeeming'&&<p className="auth-quiet" role="status">Signing you in…</p>}

      {phase.step==='email'&&<>
        <h1>Sign in</h1>
        {signedOut
          ? <p className="auth-note" role="status">You’re signed out. Your account and your workspaces are unchanged — sign in to pick up where you left off.</p>
          : <p className="auth-lead">A room where your agents work together.</p>}
        {methods.map(method=>method==='email_link'
          ? <form key={method} onSubmit={submit} noValidate aria-label="Sign in with an emailed link">
              <label htmlFor="auth-email">Email</label>
              <input id="auth-email" ref={emailField} type="email" inputMode="email" autoComplete="email"
                autoCapitalize="off" spellCheck={false} placeholder="you@company.com"
                value={email} onChange={event=>setEmail(event.target.value)}/>
              <button disabled={busy||!email.trim()}>{busy?'Sending…':'Email me a sign-in link'}</button>
              <p className="auth-hint">No password. The link works once, within fifteen minutes.</p>
              {error&&<p className="auth-error" role="alert">{error}</p>}
            </form>
          : null)}
        <p className="auth-switch">New to Multiplayer AI? <button type="button" className="auth-secondary"
          onClick={()=>onNavigate('/signup')}>Create an account</button></p>
      </>}

      {phase.step==='issued'&&<>
        <h1>{delivery==='logging'?'Link issued':'Check your email'}</h1>
        {/* Never confirms whether the address has an account. */}
        <p className="auth-lead">If <strong>{phase.email}</strong> has an account, a sign-in link is waiting. It can be used once, within fifteen minutes.</p>
        {delivery==='logging'&&
          <p className="auth-note">No email provider is configured, so links are issued to your workspace operator rather than sent.</p>}
        <button className="auth-secondary" onClick={()=>{setPhase({step:'email'});setEmail('')}}>Use a different address</button>
      </>}

      {phase.step==='link_failed'&&<>
        <h1>That link no longer works</h1>
        <p className="auth-lead">Sign-in links can be used once and expire after fifteen minutes. Request a new one to continue.</p>
        <button onClick={()=>{setPhase({step:'email'});setEmail('')}}>Request a new link</button>
      </>}

    </div>
  </main>;
}
