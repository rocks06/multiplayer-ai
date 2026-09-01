import {useEffect,useState} from 'react';
import {acceptRoomInvite,currentIdentity,previewRoomInvite,type RoomInvitePreview} from './api';
import {rememberIntent} from './SignIn';

const INVITE_KEY='mpai:pending-room-invite';
function takeToken(){
  const fromHash=location.hash.startsWith('#')?decodeURIComponent(location.hash.slice(1)):'';
  if(fromHash){
    try{sessionStorage.setItem(INVITE_KEY,fromHash)}catch{}
    history.replaceState({},'',location.pathname);
    return fromHash;
  }
  try{return sessionStorage.getItem(INVITE_KEY)??''}catch{return ''}
}
function forgetToken(){try{sessionStorage.removeItem(INVITE_KEY)}catch{}}

type State=
  |{step:'loading'}
  |{step:'anonymous';preview:RoomInvitePreview}
  |{step:'joining';preview:RoomInvitePreview}
  |{step:'error';message:string};

export default function JoinRoom({navigate}:{navigate:(to:string)=>void}){
  const [state,setState]=useState<State>({step:'loading'});
  useEffect(()=>{
    let alive=true;
    const token=takeToken();
    if(!token){setState({step:'error',message:'This invite link is incomplete.'});return}
    void (async()=>{
      const preview=await previewRoomInvite(token);
      if(!alive)return;
      const identity=await currentIdentity();
      if(!alive)return;
      if(!identity)return setState({step:'anonymous',preview});
      setState({step:'joining',preview});
      const accepted=await acceptRoomInvite(token);
      if(!alive)return;
      forgetToken();
      location.replace(accepted.room_path);
    })().catch(problem=>{if(alive)setState({step:'error',message:(problem as Error).message||'This invite no longer works.'})});
    return()=>{alive=false};
  },[]);

  const authenticate=(path:'/signin'|'/signup')=>{rememberIntent('/join');navigate(path)};
  return <main className="auth join-room">
    <div className="auth-panel">
      <div className="brand-mark" aria-hidden="true">M</div>
      {state.step==='loading'&&<p className="auth-quiet" role="status">Checking the invitation…</p>}
      {state.step==='joining'&&<><h1>Joining {state.preview.room_name}</h1><p className="auth-quiet" role="status">Adding your account to {state.preview.company_name}…</p></>}
      {state.step==='anonymous'&&<>
        <p className="eyebrow">Room invitation</p>
        <h1>{state.preview.room_name}</h1>
        <p className="auth-lead">You were invited to collaborate in <strong>{state.preview.company_name}</strong>.</p>
        <button onClick={()=>authenticate('/signin')}>Sign in to join</button>
        <button className="auth-secondary" onClick={()=>authenticate('/signup')}>Create an account</button>
        <p className="auth-note">The invitation stays pending while you authenticate and is used only when you enter the room.</p>
      </>}
      {state.step==='error'&&<>
        <h1>Invitation unavailable</h1>
        <p className="auth-lead">{state.message}</p>
        <button onClick={()=>{forgetToken();navigate('/')}}>Go home</button>
      </>}
    </div>
  </main>;
}
