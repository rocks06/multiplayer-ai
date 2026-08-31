import {useEffect,useRef,useState,type FormEvent} from 'react';
import {currentIdentity,redeemSignInToken,requestSignInLink,signInDelivery,type SignInDelivery,type SignedInIdentity} from './api';

const INTENT_KEY='mpai:after-sign-in';

/* A link in the address bar is spent once, here, at module load: it leaves the URL
   immediately so a shared or bookmarked link cannot replay it, and the redemption is a single
   module-scoped promise rather than per-mount work, so a remount attaches to the same result
   instead of racing it or discarding it. */
const redemption=(()=>{
  const token=new URLSearchParams(location.search).get('token');
  if(!token)return null;
  history.replaceState({},'',location.pathname);
  return redeemSignInToken(token).then(
    identity=>({ok:true as const,identity}),
    ()=>({ok:false as const}),
  );
})();

/** Remember where someone was heading so signing in returns them there. */
export function rememberIntent(path:string){try{sessionStorage.setItem(INTENT_KEY,path)}catch{}}
function takeIntent(){try{const value=sessionStorage.getItem(INTENT_KEY);sessionStorage.removeItem(INTENT_KEY);return value}catch{return null}}

type Phase=
 |{step:'checking'}
 |{step:'email'}
 |{step:'issued';email:string}
 |{step:'redeeming'}
 |{step:'link_failed'};

/** A real navigation by default: authenticating changes what every request can see, so the
 *  destination should mount once, cleanly, with the session already set. */
const hardNavigate=(to:string)=>{location.replace(to)};

export default function SignIn({onAuthenticated=hardNavigate}:{onAuthenticated?:(to:string)=>void}={}){
  const [phase,setPhase]=useState<Phase>({step:'checking'});
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
      // Somewhere specific if that is where they were headed; otherwise the workspace, which
      // works out for itself whether there is anything still to set up.
      onAuthenticated(intent??'/welcome');
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
        <h1>Multiplayer</h1>
        <p className="auth-lead">A room where your agents work together.</p>
        <form onSubmit={submit} noValidate>
          <label htmlFor="auth-email">Email</label>
          <input id="auth-email" ref={emailField} type="email" inputMode="email" autoComplete="email"
            autoCapitalize="off" spellCheck={false} placeholder="you@company.com"
            value={email} onChange={event=>setEmail(event.target.value)}/>
          <button disabled={busy||!email.trim()}>{busy?'Sending…':'Continue'}</button>
          {error&&<p className="auth-error" role="alert">{error}</p>}
        </form>
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
