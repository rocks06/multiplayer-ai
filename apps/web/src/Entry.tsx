import {useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight} from 'lucide-react';
import {ApiError,signInDelivery,signUp,type SignInDelivery} from './api';
import {rememberIntent} from './SignIn';

/**
 * The front door.
 *
 * Someone arriving at the root with no account has to be able to tell, without being told, that
 * this is a thing they can join and where to start. Two choices, no jargon, and nothing about
 * rooms or agents until they are in.
 */
export function Entry({onNavigate}:{onNavigate:(to:string)=>void}){
  return <main className="auth">
    <div className="auth-panel">
      <div className="brand-mark" aria-hidden="true">M</div>
      <h1>Multiplayer AI</h1>
      <p className="auth-lead">
        A shared room where the agents you already run work together, and you step in when it matters.
      </p>
      <div className="entry-actions">
        <button className="entry-primary" onClick={()=>onNavigate('/signup')}>Create account<ArrowRight size={15}/></button>
        <button className="entry-secondary" onClick={()=>onNavigate('/signin')}>Sign in</button>
      </div>
    </div>
  </main>;
}

/**
 * Creating an account asks for the two things it genuinely needs and nothing else. There is no
 * password: the same single-use link that signs people in is what finishes this.
 */
export function SignUp({onNavigate}:{onNavigate:(to:string)=>void}){
  const [name,setName]=useState('');
  const [email,setEmail]=useState('');
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const [sent,setSent]=useState(false);
  const [delivery,setDelivery]=useState<SignInDelivery>('resend');
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus()},[]);
  useEffect(()=>{void signInDelivery().then(setDelivery)},[]);

  const submit=async(event:FormEvent)=>{
    event.preventDefault();
    if(!name.trim()||!email.trim()||busy)return;
    setBusy(true);setProblem('');
    try{
      await signUp(name.trim(),email.trim());
      // Where they should end up once the link is redeemed.
      rememberIntent('/home');
      setSent(true);
    }catch(failure){
      setProblem(failure instanceof ApiError?failure.message:'That did not work. Try again.');
    }finally{setBusy(false)}
  };

  if(sent)return <main className="auth">
    <div className="auth-panel">
      <div className="brand-mark" aria-hidden="true">M</div>
      <h1>Check your email</h1>
      {/* Says nothing about whether the address already had an account. */}
      <p className="auth-lead">
        If <strong>{email.trim()}</strong> can be signed in, a link is waiting. It can be used once,
        within fifteen minutes.
      </p>
      {delivery==='logging'&&
        <p className="auth-note">No email provider is configured, so links are issued to your workspace operator rather than sent.</p>}
      <button className="auth-secondary" onClick={()=>onNavigate('/signin')}>Back to sign in</button>
    </div>
  </main>;

  return <main className="auth">
    <div className="auth-panel">
      <div className="brand-mark" aria-hidden="true">M</div>
      <h1>Create your account</h1>
      <p className="auth-lead">Two things, and no password. You will name your workspace next.</p>
      <form onSubmit={submit} noValidate>
        <label htmlFor="signup-name">Your name</label>
        <input id="signup-name" ref={field} value={name} autoComplete="name" placeholder="Priya Raman"
          maxLength={100} onChange={event=>setName(event.target.value)}/>
        <label htmlFor="signup-email">Work email</label>
        <input id="signup-email" type="email" inputMode="email" autoComplete="email" autoCapitalize="off"
          spellCheck={false} value={email} placeholder="you@company.com"
          onChange={event=>setEmail(event.target.value)}/>
        <button disabled={busy||!name.trim()||!email.trim()}>{busy?'Sending…':'Create account'}<ArrowRight size={15}/></button>
        {problem&&<p className="auth-error" role="alert">{problem}</p>}
      </form>
      <button className="auth-secondary" onClick={()=>onNavigate('/signin')}>I already have an account</button>
    </div>
  </main>;
}
