import {useEffect,useRef,useState} from 'react';
import {Bell,BellOff,Check} from 'lucide-react';
import {NOTIFICATION_CHOICES,roomNotificationPreference,setRoomNotificationPreference,
  type NotificationLevel} from './api';

/**
 * How much this room is allowed to interrupt this person.
 *
 * It is theirs and this room's together — two people in one room are not asking for the same
 * interruptions, and one person wants different things from different rooms. It governs native
 * notifications only: what is unread is what the room contains, counted the same way whatever is
 * chosen here, so turning notifications off never hides that something happened.
 */
export function RoomNotifications({companyId,roomId}:{companyId:string;roomId:string}){
  const [level,setLevel]=useState<NotificationLevel|null>(null);
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState<NotificationLevel|null>(null);
  const [problem,setProblem]=useState('');
  const menu=useRef<HTMLDivElement>(null);
  const button=useRef<HTMLButtonElement>(null);

  useEffect(()=>{
    let live=true;
    roomNotificationPreference(companyId,roomId)
      .then(current=>{if(live)setLevel(current.level)})
      .catch(()=>{if(live)setLevel('direct_mentions')});
    return()=>{live=false};
  },[companyId,roomId]);

  useEffect(()=>{
    if(!open)return;
    const away=(event:MouseEvent)=>{
      if(!menu.current?.contains(event.target as Node)&&!button.current?.contains(event.target as Node))setOpen(false);
    };
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus()}};
    document.addEventListener('mousedown',away);window.addEventListener('keydown',key);
    return()=>{document.removeEventListener('mousedown',away);window.removeEventListener('keydown',key)};
  },[open]);

  const choose=async(next:NotificationLevel)=>{
    setSaving(next);setProblem('');
    const previous=level;
    setLevel(next);
    try{await setRoomNotificationPreference(companyId,roomId,next);setOpen(false)}
    catch{setLevel(previous??null);setProblem('That did not save. Try again.')}
    finally{setSaving(null)}
  };

  const current=NOTIFICATION_CHOICES.find(choice=>choice.level===level);
  return <div className="room-notifications">
    <button ref={button} type="button" className="room-notifications-button" aria-haspopup="menu" aria-expanded={open}
      aria-label={`Notifications: ${current?.label??'loading'}`} onClick={()=>setOpen(value=>!value)}>
      {level==='off'?<BellOff size={14}/>:<Bell size={14}/>}
      <span>{current?.label??'Notifications'}</span>
    </button>
    {open&&<div ref={menu} className="room-notifications-menu" role="menu" aria-label="Notifications for this room">
      <p className="room-notifications-lead">Notify me about</p>
      {NOTIFICATION_CHOICES.map(choice=>
        <button key={choice.level} type="button" role="menuitemradio" aria-checked={choice.level===level}
          disabled={saving!==null} onClick={()=>void choose(choice.level)}>
          <span className="room-notifications-mark" aria-hidden="true">{choice.level===level?<Check size={13}/>:null}</span>
          <span className="room-notifications-copy">
            <strong>{choice.label}</strong>
            <small>{choice.detail}</small>
          </span>
        </button>)}
      <p className="room-notifications-lead">Unread counts everything, whatever you choose here.</p>
      {problem&&<p className="form-error" role="alert">{problem}</p>}
    </div>}
  </div>;
}
