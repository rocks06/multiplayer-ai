import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {Bell,BellOff,Check} from 'lucide-react';
import {NOTIFICATION_CHOICES,roomNotificationPreference,setRoomNotificationPreference,
  type NotificationLevel} from './api';

/** What the header says when there is no room for a sentence. */
const SHORT:Record<NotificationLevel,string>={all:'All',direct_mentions:'Direct',mentions:'Mentions',needs_you:'Needs you',off:'Off'};

/**
 * How much this room is allowed to interrupt this person.
 *
 * It is theirs and this room's together — two people in one room are not asking for the same
 * interruptions, and one person wants different things from different rooms. It governs native
 * notifications only: what is unread is what the room contains, counted the same way whatever is
 * chosen here, so turning notifications off never hides that something happened.
 *
 * The panel is a deliberate layer rather than a label floating over the conversation: a scrim
 * behind it, one column of rows, and each row a name with a line saying what it means.
 */
export function RoomNotifications({companyId,roomId}:{companyId:string;roomId:string}){
  const [level,setLevel]=useState<NotificationLevel|null>(null);
  const [open,setOpen]=useState(false);
  const [saving,setSaving]=useState<NotificationLevel|null>(null);
  const [problem,setProblem]=useState('');
  const panel=useRef<HTMLDivElement>(null);
  const button=useRef<HTMLButtonElement>(null);
  const [place,setPlace]=useState<{top:number;left:number}>({top:0,left:0});

  useEffect(()=>{
    let live=true;
    roomNotificationPreference(companyId,roomId)
      .then(current=>{if(live)setLevel(current.level)})
      .catch(()=>{if(live)setLevel('direct_mentions')});
    return()=>{live=false};
  },[companyId,roomId]);

  useEffect(()=>{
    if(!open)return;
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){setOpen(false);button.current?.focus()}};
    window.addEventListener('keydown',key);
    return()=>window.removeEventListener('keydown',key);
  },[open]);
  useEffect(()=>{if(open)panel.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus()},[open]);

  /* Placed against the window rather than against the header.
     The header is a translucent layer, which makes it the containing block for anything fixed
     inside it — so a panel positioned against the window from in there landed off-screen on a
     narrow one. It is drawn at the top level and measured into place: under its button when there
     is room, pushed back inside the window when there is not, never off any edge. */
  useLayoutEffect(()=>{
    if(!open)return;
    const fit=()=>{
      const anchor=button.current?.getBoundingClientRect();
      const box=panel.current?.getBoundingClientRect();
      if(!anchor||!box)return;
      const margin=12;
      const room=Math.max(0,window.innerHeight-box.height-margin);
      const top=Math.min(Math.max(margin,anchor.bottom+8),room||margin);
      const left=Math.min(Math.max(margin,anchor.right-box.width),Math.max(margin,window.innerWidth-box.width-margin));
      setPlace(current=>current.top===top&&current.left===left?current:{top,left});
    };
    fit();
    window.addEventListener('resize',fit);window.addEventListener('scroll',fit,true);
    return()=>{window.removeEventListener('resize',fit);window.removeEventListener('scroll',fit,true)};
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
      <span>{level?SHORT[level]:'Notifications'}</span>
    </button>
    {open&&createPortal(<>
      {/* Clicking away closes it, and nothing underneath is clicked by accident on the way out. */}
      <button type="button" className="room-notifications-scrim" aria-label="Close notification settings"
        onClick={()=>{setOpen(false);button.current?.focus()}}/>
      <div ref={panel} className="room-notifications-panel" role="menu" aria-label="Notifications for this room"
        style={{top:place.top,left:place.left}}>
        <p className="room-notifications-title">Notify me about</p>
        <div className="room-notifications-rows">
          {NOTIFICATION_CHOICES.map(choice=>
            <button key={choice.level} type="button" role="menuitemradio" aria-checked={choice.level===level}
              disabled={saving!==null} onClick={()=>void choose(choice.level)}>
              <span className="room-notifications-copy">
                <strong>{choice.label}</strong>
                <small>{choice.detail}</small>
              </span>
              <span className="room-notifications-mark" aria-hidden="true">{choice.level===level?<Check size={14}/>:null}</span>
            </button>)}
        </div>
        <p className="room-notifications-foot">Unread counts everything, whatever you choose here.</p>
        {problem&&<p className="form-error" role="alert">{problem}</p>}
      </div>
    </>,document.body)}
  </div>;
}
