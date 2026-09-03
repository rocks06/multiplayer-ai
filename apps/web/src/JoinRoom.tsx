import {useEffect,useState} from 'react';
import {acceptRoomInvite,currentIdentity,previewRoomInvite,type RoomInvitePreview} from './api';
import {rememberIntent} from './SignIn';
import {rememberAcross} from './pending-invite';

const INVITE_KEY='mpai:pending-room-invite';
/* Held where the tab the magic link opens can find it — see pending-invite.ts. The secret comes
   out of the address bar immediately either way, so a shared or bookmarked URL carries nothing. */
function takeToken(){
  const fromHash=location.hash.startsWith('#')?decodeURIComponent(location.hash.slice(1)):'';
  if(fromHash){
    rememberAcross.write(INVITE_KEY,fromHash);
    history.replaceState({},'',location.pathname);
    return fromHash;
  }
  return rememberAcross.read(INVITE_KEY)??'';
}
function forgetToken(){rememberAcross.forget(INVITE_KEY)}

type Accepted={companyId:string;roomId:string;roomPath:string};
type State=
  |{step:'loading'}
  |{step:'anonymous';preview:RoomInvitePreview}
  |{step:'joining';preview:RoomInvitePreview}
  |{step:'joined';preview:RoomInvitePreview;accepted:Accepted}
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
      /* Membership exists on the server now, so the secret has done its work and is dropped here.
         Nothing after this point needs it, and nothing after this point should still be holding
         it — including the browser this happened in. */
      forgetToken();
      setState({step:'joined',preview,accepted:{
        companyId:accepted.company_id,roomId:accepted.room_id,roomPath:accepted.room_path}});
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
      {state.step==='joined'&&<Continue accepted={state.accepted} preview={state.preview}/>}
      {state.step==='error'&&<>
        <h1>Invitation unavailable</h1>
        <p className="auth-lead">{state.message}</p>
        <button onClick={()=>{forgetToken();navigate('/')}}>Go home</button>
      </>}
    </div>
  </main>;
}

/**
 * Where a person actually works, once they are in the room.
 *
 * Accepting used to drop straight into the browser, and the room then existed only there: opening
 * the Mac app afterwards showed no sign of it. Membership is the server's, so the app can simply
 * be told which room to open — the two ids and nothing else. The invite secret is spent and gone
 * by this point, and none of this depends on anything the browser is still holding.
 *
 * The app is offered, never forced. A browser cannot be asked whether a scheme has a handler, so
 * this asks the Mac to open it and then watches: an app that opens takes the focus away. If
 * nothing happens, the page is still here, and it says so and offers the two honest alternatives
 * rather than leaving somebody looking at a button that did nothing.
 */
function Continue({accepted,preview}:{accepted:Accepted;preview:RoomInvitePreview}){
  const [noApp,setNoApp]=useState(false);
  const target=`multiplayerai://room?company=${encodeURIComponent(accepted.companyId)}`
    +`&room=${encodeURIComponent(accepted.roomId)}`;

  const open=()=>{
    let handedOver=false;
    const note=()=>{handedOver=true};
    addEventListener('blur',note);addEventListener('pagehide',note);
    location.href=target;
    setTimeout(()=>{
      removeEventListener('blur',note);removeEventListener('pagehide',note);
      if(!handedOver&&document.visibilityState!=='hidden'&&document.hasFocus())setNoApp(true);
    },1800);
  };

  return <>
    <p className="eyebrow">You have joined</p>
    <h1>{preview.room_name}</h1>
    <p className="auth-lead">You are a member of <strong>{preview.company_name}</strong>. Multiplayer AI
      is where this room is worked in.</p>
    <button onClick={open}>Open in Multiplayer AI</button>
    <button className="auth-secondary" onClick={()=>location.replace(accepted.roomPath)}>
      Continue in this browser
    </button>
    {noApp&&<p className="auth-note" role="status">
      Multiplayer AI did not open, so it may not be installed on this Mac.{' '}
      <a href="/download">Download it</a>, or carry on in the browser — the room is yours either way.
    </p>}
  </>;
}
