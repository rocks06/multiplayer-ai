import {useEffect,useRef,useState} from 'react';
import {ChevronDown} from 'lucide-react';
import {signOutAndLeave,type WorkspaceRoom} from './api';
import {ContextualOnboarding} from './ContextualOnboarding';

/**
 * The frame around every signed-in page.
 *
 * It exists to answer three questions without anyone having to ask: which workspace am I in, how
 * do I get back, and where is the room I was in. It is a single restrained bar rather than a
 * sidebar, because the room underneath is the product and should keep the width.
 */
export function Shell({workspace,rooms,currentRoomId,onNavigate,onboardingKey,bar:showBar=true,children}:{
  workspace:{companyId:string;name:string}|null;
  rooms:WorkspaceRoom[];
  currentRoomId?:string;
  onNavigate:(to:string)=>void;
  onboardingKey?:string;
  /** Off inside a room, which is immersive and has its own way Home. */
  bar?:boolean;
  children:React.ReactNode}){
  const [roomsOpen,setRoomsOpen]=useState(false);
  const [accountOpen,setAccountOpen]=useState(false);
  const bar=useRef<HTMLElement>(null);

  // A menu that stays open after you have looked away is clutter.
  useEffect(()=>{
    if(!roomsOpen&&!accountOpen)return;
    const away=(event:MouseEvent)=>{if(!bar.current?.contains(event.target as Node)){setRoomsOpen(false);setAccountOpen(false)}};
    const escape=(event:KeyboardEvent)=>{if(event.key==='Escape'){setRoomsOpen(false);setAccountOpen(false)}};
    addEventListener('mousedown',away);addEventListener('keydown',escape);
    return()=>{removeEventListener('mousedown',away);removeEventListener('keydown',escape)};
  },[roomsOpen,accountOpen]);

  const current=rooms.find(room=>room.room_id===currentRoomId);

  return <div className={showBar?'shell':'shell immersive'}>
    {showBar&&<header className="shell-bar" ref={bar}>
      <button type="button" className="shell-home" onClick={()=>onNavigate('/home')}>
        <span className="brand-mark" aria-hidden="true">M</span>
        <span className="shell-workspace">{workspace?.name??'Home'}</span>
      </button>

      {rooms.length>0&&<div className="shell-rooms">
        <button type="button" data-onboarding="rooms" aria-expanded={roomsOpen} onClick={()=>{setRoomsOpen(v=>!v);setAccountOpen(false)}}>
          {current?current.name:'Rooms'}<ChevronDown size={13}/>
        </button>
        {roomsOpen&&<div className="shell-menu" role="menu">
          {rooms.map(room=>
            <button type="button" key={room.room_id} role="menuitem"
              onClick={()=>{setRoomsOpen(false);if(workspace)onNavigate(`/rooms/${workspace.companyId}/${room.room_id}`)}}>
              <span>{room.name}</span>
              {room.project_name!==room.name&&<small>{room.project_name}</small>}
            </button>)}
        </div>}
      </div>}

      <div className="shell-spacer"/>

      <div className="shell-account">
        <button type="button" aria-expanded={accountOpen} aria-label="Account"
          onClick={()=>{setAccountOpen(v=>!v);setRoomsOpen(false)}}>•••</button>
        {accountOpen&&<div className="shell-menu right" role="menu">
          <button type="button" role="menuitem" onClick={()=>{setAccountOpen(false);onNavigate('/settings')}}>Settings</button>
          <button type="button" role="menuitem"
            onClick={signOutAndLeave}>Sign out</button>
        </div>}
      </div>
    </header>}
    <div className="shell-body">{children}</div>
    {onboardingKey&&<ContextualOnboarding identityKey={onboardingKey}/>}
  </div>;
}
