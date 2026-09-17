import {Fragment,memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {ArrowUp,Check,ChevronDown,ChevronRight,Clock3,Copy,Plus,RefreshCw,Share2,ShieldAlert,Users,X} from 'lucide-react';
import {agentRoomMove,connectOnMac,handoffAgentMove} from './agent-room-move';
import {bodySegments} from './mentions';
import {ApiError,addRoomMember,addWorkspaceAgent,currentIdentity,deleteWorkspaceRoom,listWorkspaceAgents,listWorkspaceRooms,roomFromLocation,type SignedInIdentity,type WorkspaceRoom} from './api';
import SignIn,{rememberIntent} from './SignIn';
import {useConfirm} from './Confirm';
import {RoomNotifications} from './RoomNotifications';
import PresenceFixture from './PresenceFixture';
import DecisionFixture from './DecisionFixture';
import Welcome,{ConnectAgent} from './Welcome';
import {Entry,SignUp} from './Entry';
import {Home} from './Home';
import {Settings} from './Settings';
import JoinRoom from './JoinRoom';
import {Shell} from './Shell';
import {AgentControls,SharedWork,type WorkActions} from './Work';
import {describePresence,elapsedLabel,type AgentPresence} from './presence';
import {useRoomSession} from './use-room';
import type {CompanyAgent,ConnectionState,Decision,Member,Message,RoomEvent,RoomIdentity,RoomSnapshot,Task,TaskStatus,ReadPosition} from './types';
import type {WorkspaceAgent} from './api';
import './styles.css';
import {AttachmentCard,AttachmentComposer,RoomFiles} from './Attachments';
import type {RoomApi} from './api';

const formatTime=(value:string)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(value));

/**
 * Which day something was said.
 *
 * A room keeps its history, so a wall of times with no dates reads as though everything happened
 * this afternoon. The stored timestamp is untouched — this only decides what to write above the
 * first message of each day, in the reader's own locale and time zone.
 */
export function dayLabel(value:string,now=new Date()){
  const at=new Date(value);
  const midnight=(d:Date)=>new Date(d.getFullYear(),d.getMonth(),d.getDate()).getTime();
  const days=Math.round((midnight(now)-midnight(at))/86_400_000);
  if(days===0)return 'Today';
  if(days===1)return 'Yesterday';
  // Within the year the year itself is noise; outside it, it is the whole point.
  return new Intl.DateTimeFormat(undefined,at.getFullYear()===now.getFullYear()
    ?{month:'short',day:'numeric'}
    :{year:'numeric',month:'short',day:'numeric'}).format(at);
}

/** Whether two timestamps fall on different days for the reader. */
export const startsNewDay=(value:string,previous?:string)=>{
  if(!previous)return true;
  const a=new Date(value),b=new Date(previous);
  return a.getFullYear()!==b.getFullYear()||a.getMonth()!==b.getMonth()||a.getDate()!==b.getDate();
};

function Mark({member}:{member:Member}){return <span className={`identity-mark ${member.kind}`} aria-hidden="true">{member.display_name.slice(0,1).toUpperCase()}</span>}
/** One shared clock for the whole rail, coarse enough that labels do not rewrite themselves. */
function useCoarseNow(active:boolean){
  const [now,setNow]=useState(()=>Date.now());
  useEffect(()=>{
    if(!active)return;
    const id=setInterval(()=>setNow(Date.now()),15_000);
    return()=>clearInterval(id);
  },[active]);
  return now;
}

/* Primitive props so the memo actually holds: a row re-renders only when something it shows
   has changed, not every time the rail's clock ticks. */
const PresenceRow=memo(function PresenceRow({name,initial,label,tone,detail,elapsed,lastSeenAt,paused}:{name:string;initial:string;label:string;tone:string;detail?:string;elapsed:string|null;lastSeenAt?:string;paused?:boolean}){
  return <>
    <span className="identity-mark agent" aria-hidden="true">{initial}</span>
    <span className="person-copy">
      <strong>{name}</strong>
      <small className="person-state">
        <span className={`state-dot ${tone}`} aria-hidden="true"/>
        <span className="state-label">{label}</span>
        {/* Paused is a supervisory state, shown beside reachability rather than hiding it. */}
        {paused&&<span className="paused-chip">Paused</span>}
        {elapsed&&<span className="state-since" title={lastSeenAt}>{elapsed}</span>}
      </small>
      {detail&&<small className="person-detail">{detail}</small>}
    </span>
  </>;
});

function HumanRow({member,current}:{member:Member;current:boolean}){
  return <li className="person-row">
    <Mark member={member}/>
    <span className="person-copy">
      <strong>{member.display_name}{current&&<em>you</em>}</strong>
      <small className="person-state"><span className="state-label">{member.role.replace('_',' ')}</span></small>
    </span>
  </li>;
}

/**
 * Bringing another agent into this room.
 *
 * Agents arrive one at a time and rarely, so this stays folded away beside the team rather than
 * standing as a permanent call to action. It adds nothing new to the model: an agent the
 * workspace already knows is simply made a member here, and a new name registers an identity and
 * then does the same. Connecting it to the machine it runs on is the existing flow, opened for
 * you straight afterwards.
 */
function AddAgent({available,onAdd}:{available:CompanyAgent[];onAdd:(choice:{name?:string;principalId?:string})=>Promise<void>}){
  const [open,setOpen]=useState(false);
  const [name,setName]=useState('');
  const [existing,setExisting]=useState('');
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(open&&!available.length)field.current?.focus()},[open,available.length]);

  const submit=async(choice:{name?:string;principalId?:string})=>{
    if(busy)return;
    setBusy(true);setProblem('');
    try{await onAdd(choice);setName('');setExisting('');setOpen(false)}
    catch(failure){setProblem((failure as Error).message||'That did not work.')}
    finally{setBusy(false)}
  };

  if(!open)return <button type="button" className="add-agent-row" onClick={()=>setOpen(true)}>
    <Plus size={13}/>Add agent</button>;

  return <form className="add-agent-form" onSubmit={event=>{event.preventDefault();if(name.trim())void submit({name:name.trim()})}}>
    {available.length>0&&<label className="field">
      <span className="field-label">Agent you already have</span>
      <select value={existing} disabled={busy} aria-label="Add an agent already in this workspace"
        onChange={event=>{const id=event.target.value;setExisting(id);if(id)void submit({principalId:id})}}>
        <option value="">Choose an agent…</option>
        {available.map(agent=><option value={agent.principal_id} key={agent.principal_id}>{agent.display_name}</option>)}
      </select>
    </label>}

    <label className="field">
      <span className="field-label">{available.length?'Or connect a new one':'Agent name'}</span>
      <input ref={field} value={name} placeholder="Research agent" maxLength={100} disabled={busy}
        aria-label="Agent name" onChange={event=>setName(event.target.value)}/>
    </label>
    <small className="add-agent-note">Names an agent you already run. You connect it from its own Mac next.</small>

    {problem&&<p className="form-error" role="alert">{problem}</p>}
    <div className="add-agent-actions">
      <button type="button" onClick={()=>{setOpen(false);setName('');setProblem('')}} disabled={busy}>Cancel</button>
      <button disabled={busy||!name.trim()}>{busy?'Adding…':'Add agent'}</button>
    </div>
  </form>;
}

export function Participants({members,currentId,tasks,decisions,companyAgents,canManage,actions,onMessage,onConnect,onDisconnect,onRemove,onAddAgent,ownerNames={}}:{
  members:Member[];currentId:string;ownerNames?:Record<string,string[]>;tasks:Task[];decisions:Decision[];
  companyAgents?:CompanyAgent[];canManage?:boolean;actions?:WorkActions;onMessage?:(principalId:string)=>void;
  onConnect?:(member:Member)=>void;onDisconnect?:(member:Member)=>Promise<void>;onRemove?:(member:Member)=>Promise<void>;onAddAgent?:(choice:{name?:string;principalId?:string})=>Promise<void>}){
  const humans=members.filter(m=>m.kind==='human'),agents=members.filter(m=>m.kind==='agent');
  // Only agents that are not currently reachable carry an elapsed reading, so the clock runs
  // only when something on screen actually depends on it.
  const presences=agents.map(agent=>({agent,presence:describePresence(agent,{tasks,decisions,members})}));
  const now=useCoarseNow(presences.some(entry=>entry.presence.since));
  return <aside className="participants" aria-label="Room participants" data-onboarding="agents">
    <div className="rail-heading"><Users size={15}/><span>In this room</span><b>{members.length}</b></div>
    <section><h2>People</h2><ul>{humans.map(m=><HumanRow key={m.principal_id} member={m} current={m.principal_id===currentId}/>)}</ul></section>
    <section><h2>Agents</h2><ul>{presences.map(({agent,presence})=>{
      const record=companyAgents?.find(a=>a.principal_id===agent.principal_id);
      return <li className="person-row" key={agent.principal_id}>
        <PresenceRow name={agent.display_name} initial={agent.display_name.slice(0,1).toUpperCase()}
          label={presence.label} tone={presence.tone} detail={presence.detail} paused={record?.status==='paused'}
          elapsed={elapsedLabel(presence.since,now)} lastSeenAt={agent.agent_last_seen_at??undefined}/>
        {actions&&onMessage&&
          <AgentControls member={agent} agent={record} canManage={Boolean(canManage)} actions={actions} onMessage={onMessage} onConnect={onConnect} onDisconnect={onDisconnect} onRemove={onRemove}/>}
      </li>;
    })}</ul>
      {!agents.length&&<p className="small-empty">No agents here yet. Add one you already run.</p>}
      {/* Only agents this workspace knows and this room does not already have. */}
      {canManage&&onAddAgent&&
        <AddAgent available={(companyAgents??[]).filter(a=>!members.some(m=>m.principal_id===a.principal_id))} onAdd={onAddAgent}/>}
    </section>
    <div className="rail-note"><span className="presence-ring"/>Agent presence is durable Gateway state, never inferred.</div>
  </aside>;
}

function Connection({state}:{state:ConnectionState}){
  const copy:Record<ConnectionState,string>={connecting:'Connecting',live:'Live',reconnecting:'Reconnecting',resyncing:'Resyncing',offline:'Offline',revoked:'Access removed'};
  return <span className={`connection ${state}`} role="status"><i/>{copy[state]}</span>
}
function activityText(event:RoomEvent){
  const target=typeof event.payload?.title==='string'?` “${event.payload.title}”`:'';
  const copy:Record<string,string>={
    'task.created':`created task${target}`,'task.status_updated':`updated a task to ${String(event.payload?.status??'a new state').replaceAll('_',' ')}`,
    'decision.requested':'requested a human decision','decision.approved':'approved a decision','decision.rejected':'rejected a decision',
    'agent.run_queued':'queued agent work','agent.run_started':'started working','agent.run_resumed':'returned to work','agent.run_completed':'completed a work session',
    'member.joined':'joined the room','member.removed':'left the room','message.sent':'sent a message'
  };
  return copy[event.event_type]??event.event_type.replaceAll('.',' ').replaceAll('_',' ');
}

type AgentStatus={label:string;tone:'ok'|'busy'|'warn'|'off'|'bad';title:string};
/**
 * Describe one message from relationships the engine stores: who sent it, whom it addresses,
 * and which message it answers. Nothing is inferred from what happens to sit above it.
 */
/**
 * Scroll a container, and make sure it actually scrolled. Some environments accept a smooth
 * scroll request and silently ignore the behaviour, which would otherwise leave the transcript
 * never moving to new messages and reply links doing nothing at all.
 */
const prefersReducedMotion=()=>typeof matchMedia==='function'&&matchMedia('(prefers-reduced-motion: reduce)').matches;

function scrollTranscript(list:HTMLElement,top:number){
  const target=Math.max(0,top);
  const from=list.scrollTop;
  if(prefersReducedMotion()||typeof list.scrollTo!=='function'){
    list.scrollTop=target;
    return;
  }
  list.scrollTo({top:target,behavior:'smooth'});
  requestAnimationFrame(()=>requestAnimationFrame(()=>{
    if(list.scrollTop===from&&Math.abs(target-from)>2)list.scrollTop=target;
  }));
}

function relationshipOf(message:Message,byId:Map<string,Message>,members:Member[]){
  const parent=message.in_reply_to_message_id?byId.get(message.in_reply_to_message_id):undefined;
  const addressee=message.addressed_principal_id?members.find(m=>m.principal_id===message.addressed_principal_id):undefined;
  // A reply that answers the person it is addressed to says so once, not twice.
  const addressRedundant=Boolean(parent&&addressee&&parent.sender_principal_id===addressee.principal_id);
  const between=message.sender_kind==='agent'&&(addressee?.kind==='agent'||parent?.sender_kind==='agent');
  return {
    parent,
    addressee,
    showAddress:Boolean(addressee)&&!addressRedundant,
    /* Only claim a reply exists; claim who it answers only when that message is loaded — and
       never when the answer is to the sender's own earlier message. An agent that posts progress
       and then a result is continuing, not replying to itself, and "Replying to <its own name>"
       reads as though it is talking to a mirror. */
    reply:message.in_reply_to_message_id&&parent?.sender_principal_id!==message.sender_principal_id
      ?{sender:parent?.sender_name,excerpt:parent?.body_text,id:message.in_reply_to_message_id}
      :undefined,
    direction:message.sender_kind==='agent'?(addressee?.kind==='human'?'to-human':between?'between-agents':'broadcast'):(addressee?'to-agent':'broadcast'),
  };
}

const DECISION_VERBS:Record<string,string>={'decision.requested':'asked for a decision','decision.approved':'approved','decision.rejected':'rejected','decision.cancelled':'cancelled a decision','decision.expired':'decision expired'};

/**
 * Read receipts on a person's own message. People who have read up to it are "seen"; agents whose
 * connector has had it delivered are listed apart, because delivery to software is not somebody
 * having read it. Quiet until there is something to say.
 */
export function receiptsFor(message:Pick<Message,'room_seq'>,positions:ReadPosition[],senderId:string){
  const seq=message.room_seq??null;
  if(seq===null)return {seen:[] as ReadPosition[],delivered:[] as ReadPosition[]};
  const others=positions.filter(p=>p.principal_id!==senderId);
  return {
    seen:others.filter(p=>p.kind==='human'&&(p.last_read_seq??0)>=seq),
    delivered:others.filter(p=>p.kind==='agent'&&(p.delivered_seq??0)>=seq),
  };
}

function Receipts({message,positions,senderId}:{message:Message;positions:ReadPosition[];senderId:string}){
  const [open,setOpen]=useState(false);
  const {seen,delivered}=receiptsFor(message,positions,senderId);
  if(!seen.length&&!delivered.length)return null;
  const label=[seen.length?`Seen by ${seen.length}`:null,delivered.length?`Delivered to ${delivered.length} ${delivered.length===1?'agent':'agents'}`:null].filter(Boolean).join(' · ');
  return <div className="receipts">
    <button type="button" aria-expanded={open} onClick={()=>setOpen(v=>!v)}>{label}</button>
    {open&&<dl>
      {seen.length>0&&<><dt>Seen by</dt><dd>{seen.map(p=>p.display_name).join(', ')}</dd></>}
      {delivered.length>0&&<><dt>Delivered to</dt><dd>{delivered.map(p=>p.display_name).join(', ')}</dd></>}
    </dl>}
  </div>;
}

function Transcript({messages,members,events,lastEvent,api,currentId='',readPositions=[],openingReadSeq=null,onAtLatest}:{messages:Message[];members:Member[];events:RoomEvent[];lastEvent:RoomEvent|null;api:RoomApi;currentId?:string;readPositions?:ReadPosition[];
  /** How far this person had read when the room opened. Fixed for the visit, so the divider stays put. */
  openingReadSeq?:number|null|undefined;onAtLatest?:(atLatest:boolean)=>void}){
  /* A decision belongs in the room's story: asked here, answered here, in the order it
     happened. Once resolved it stops asking for attention and simply stays as what occurred. */
  const timeline=useMemo(()=>{
    const titles=new Map<string,string>();
    for(const event of events)
      if(event.event_type==='decision.requested'&&event.payload?.decision_id)
        titles.set(String(event.payload.decision_id),String(event.payload.title??''));
    const entries=[
      ...messages.map(message=>({kind:'message' as const,at:message.created_at,key:message.id,message})),
      ...events.filter(event=>event.event_type.startsWith('decision.')).map(event=>({
        kind:'decision' as const,at:event.created_at,key:`event-${event.room_seq}`,event,
        title:titles.get(String(event.payload?.decision_id??''))??'',
      })),
    ];
    return entries.sort((a,b)=>Date.parse(a.at)-Date.parse(b.at)||a.key.localeCompare(b.key));
  },[messages,events]);

  const byId=useMemo(()=>new Map(messages.map(m=>[m.id,m])),[messages]);
  const listRef=useRef<HTMLDivElement>(null);
  const [unseen,setUnseen]=useState(0);
  const [focusedReply,setFocusedReply]=useState<string|null>(null);
  const count=timeline.length;

  /* Where unread begins for this visit: the first message from someone else after where this person
     had read to when they came in. A divider marks it, and the room opens there with some of what
     came before still in view. With nothing unread, the room opens at the latest message. */
  const unread=useMemo(()=>{
    if(openingReadSeq===null||openingReadSeq===undefined)return {firstId:null as string|null,count:0};
    const after=messages.filter(m=>m.sender_principal_id!==currentId&&(m.room_seq??0)>openingReadSeq);
    return {firstId:after[0]?.id??null,count:after.length};
  },[messages,openingReadSeq,currentId]);
  const [atLatest,setAtLatest]=useState(true);
  const positioned=useRef(false);
  const dividerRef=useRef<HTMLDivElement>(null);
  const measureLatest=useCallback(()=>{
    const el=listRef.current;if(!el)return;
    const at=el.scrollHeight-el.scrollTop-el.clientHeight<80;
    setAtLatest(at);onAtLatest?.(at);
    if(at)setUnseen(0);
  },[onAtLatest]);
  useLayoutEffect(()=>{
    const el=listRef.current;
    if(positioned.current||!el||!count)return;
    positioned.current=true;
    if(/^#(message|decision)-/i.test(location.hash)){measureLatest();return}
    const divider=dividerRef.current;
    if(divider){
      const context=Math.min(120,el.clientHeight/4);
      el.scrollTop=Math.max(0,el.scrollTop+divider.getBoundingClientRect().top-el.getBoundingClientRect().top-context);
    } else el.scrollTop=el.scrollHeight;
    measureLatest();
  },[count,measureLatest]);
  useEffect(()=>{
    const el=listRef.current;if(!el||!positioned.current)return;
    const near=el.scrollHeight-el.scrollTop-el.clientHeight<100;
    if(near){scrollTranscript(el,el.scrollHeight);requestAnimationFrame(measureLatest)}else setUnseen(n=>n+1);
  },[count]);
  const jump=()=>{const el=listRef.current;if(el){scrollTranscript(el,el.scrollHeight);setTimeout(measureLatest,350)}setUnseen(0)};
  /* Arriving from a notification: go to the message it was about, once it is on screen. */
  const focused=useRef('');
  useEffect(()=>{
    const hash=location.hash.match(/^#message-([0-9a-f-]{36})$/i)?.[1];
    if(!hash||focused.current===hash)return;
    const list=listRef.current,target=list?.querySelector<HTMLElement>(`[data-message-id="${hash}"]`);
    if(!list||!target)return;
    focused.current=hash;
    list.scrollTop=Math.max(0,list.scrollTop+target.getBoundingClientRect().top-list.getBoundingClientRect().top-list.clientHeight/3);
    setFocusedReply(hash);setTimeout(()=>setFocusedReply(current=>current===hash?null:current),2400);
  },[count]);

  // Following a reply moves to the message it answers and marks it briefly, so a thread can be
  // read without it being pulled out of chronology into a side channel.
  const followReply=(id:string,from:HTMLElement)=>{
    // Derived from the element that was clicked, so it is always the live scroll container.
    const list=from.closest<HTMLElement>('.transcript');
    const target=list?.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
    if(!list||!target)return;
    // Scroll the transcript itself by a measured amount rather than asking the browser to
    // choose a scroll container, so the answered message reliably lands in view.
    const delta=target.getBoundingClientRect().top-list.getBoundingClientRect().top;
    // Following a reply lands immediately, like following a footnote: arriving reliably at the
    // answered message matters more than animating the way there.
    list.scrollTop=Math.max(0,list.scrollTop+delta-Math.max(0,(list.clientHeight-target.offsetHeight)/2));
    setFocusedReply(id);
    setTimeout(()=>setFocusedReply(current=>current===id?null:current),1600);
  };

  return <div className="transcript-wrap">
    <div className="pulse-rail" aria-hidden="true"><span className={lastEvent?'pulse active':'pulse'}/></div>
    <div className="transcript" ref={listRef} data-testid="transcript" onScroll={measureLatest}>
      {!timeline.length&&<div className="empty"><strong>The room is ready.</strong><p>Start with a clear direction or assign the first piece of work.</p></div>}
      {timeline.map((entry,index)=>{
        if(entry.kind==='decision'){
          const verb=DECISION_VERBS[entry.event.event_type]??entry.event.event_type;
          return <p className="timeline-note" key={entry.key}>
            <span className="note-rule" aria-hidden="true"/>
            <span><strong>{entry.event.actor_display_name}</strong> {verb}{entry.title&&<> · {entry.title}</>}</span>
            <time dateTime={entry.at}>{formatTime(entry.at)}</time>
          </p>;
        }
        const message=entry.message;
        const previous=timeline[index-1];
        // Grouping only hides a repeated name; it never implies a relationship.
        const same=previous?.kind==='message'&&previous.message.sender_principal_id===message.sender_principal_id;
        const rel=relationshipOf(message,byId,members);
          const previousAt=previous?.kind==='message'?previous.message.created_at:undefined;
          const divider=message.id===unread.firstId
            ?<div ref={dividerRef} className="unread-divider" role="separator" aria-label={`${unread.count} unread ${unread.count===1?'message':'messages'}`}>
                <span>{unread.count} unread {unread.count===1?'message':'messages'}</span></div>
            :null;
          const body=<article
          className={`message ${message.sender_kind} ${rel.direction} ${same?'continued':''} ${focusedReply===message.id?'reply-target':''}`}
          key={message.id} id={`message-${message.id}`} data-message-id={message.id}>
          {!same
            ? <header>
                <span className={`sender-glyph ${message.sender_kind}`}>{message.sender_name.slice(0,1)}</span>
                <strong>{message.sender_name}</strong>
                <span className="kind-mark">{message.sender_kind==='agent'?'AI':'Human'}</span>
                <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
              </header>
            /* Grouping hides a repeated name, never the time. A run of replies under one
               timestamp leaves every message below it undated, which is what makes a long
               conversation impossible to place. */
            : <time className="message-time" dateTime={message.created_at}>{formatTime(message.created_at)}</time>}
          <div className="message-body">
            {rel.reply&&(rel.reply.excerpt
              ? <button type="button" className="reply-cue" onClick={event=>followReply(rel.reply!.id,event.currentTarget)}>
                  <span className="reply-who">Replying to {rel.reply.sender}</span>
                  <span className="reply-excerpt">{rel.reply.excerpt}</span>
                </button>
              : <span className="reply-cue static"><span className="reply-who">Replying to an earlier message</span></span>)}
            {rel.showAddress&&<span className={`address ${rel.addressee?.kind}`}>To {rel.addressee?.display_name}</span>}
            <p>{bodySegments(message.body_text,message.mentions).map((segment,i)=>segment.mention
              ? <span key={i} className={`mention ${segment.mention.kind}`} data-principal-id={segment.mention.principal_id}>{segment.text}</span>
              : <Fragment key={i}>{segment.text}</Fragment>)}</p>
            {message.attachments?.map(file=><AttachmentCard key={file.id} artifact={file} api={api}/>)}
            {message.sender_principal_id===currentId&&<Receipts message={message} positions={readPositions} senderId={currentId}/>}
          </div>
          </article>;
          /* The day, written once above the first message of it. A room keeps its history, so a
             column of times with no dates reads as though all of it happened this afternoon. */
          if(!startsNewDay(message.created_at,previousAt))return divider?<Fragment key={`unread-${message.id}`}>{divider}{body}</Fragment>:body;
          return <div key={`day-${message.id}`} className="day-group">
            <div className="day-separator" role="separator">
              <span>{dayLabel(message.created_at)}</span>
            </div>
            {divider}{body}
          </div>;
        })}
    </div>
    {!atLatest&&<button type="button" className="new-items" onClick={jump}>{unseen>0?`${unseen} new · Jump to latest`:'Jump to latest'} <ArrowUp size={13}/></button>}
  </div>
}

function Composer({members,onSend,to,onAddressee,focusToken}:{members:Member[];onSend:(body:string,to?:string)=>Promise<void>;to:string;onAddressee:(id:string)=>void;focusToken:number}){
  const [body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const field=useRef<HTMLTextAreaElement>(null);
  // Choosing to message an agent should land the person in the box, ready to write.
  useEffect(()=>{if(focusToken)field.current?.focus()},[focusToken]);
  const submit=async(e?:FormEvent)=>{e?.preventDefault();if(!body.trim()||busy)return;setBusy(true);setError('');try{await onSend(body.trim(),to||undefined);setBody('')}catch(x){setError((x as Error).message)}finally{setBusy(false)}};
  return <form className="composer" onSubmit={submit} aria-label="Send a room message" data-onboarding="conversation">
    <div className="composer-meta"><label>Send to <select value={to} onChange={e=>onAddressee(e.target.value)}><option value="">Everyone</option>{members.map(m=><option value={m.principal_id} key={m.principal_id}>{m.display_name}</option>)}</select></label><span>Enter to send · Shift Enter for a new line</span></div>
    <div className="composer-input"><textarea ref={field} aria-label="Message" placeholder="Add direction, context, or a question…" value={body} rows={2} onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void submit()}}}/><button disabled={!body.trim()||busy} aria-label="Send message"><ArrowUp size={18}/></button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
  </form>
}

/**
 * A decision is an authorisation, not a conversation. Collapsed it states who is asking and
 * what for; opened it answers the rest: what they want to do, why a human is needed, exactly
 * what is being authorised, and what happens next. The proposed action is shown verbatim and
 * is what the server digest-locks — the note travels with the decision and changes nothing
 * about the action itself, which the label says in as many words.
 */
/**
 * What the server refused, said in terms of the decision rather than the request. Anything we
 * have not given a person-facing reading of keeps the server's own message, which is at least
 * specific — never a bare status number.
 */
function resolutionProblem(problem:unknown):string{
  const code=problem instanceof ApiError?problem.code:'';
  if(code==='decision_already_resolved')return 'Someone else already decided this. Reload to see what they chose.';
  if(code==='version_conflict'||code==='stale_decision_action')return 'This decision changed while you were reading it. Reload and review it again.';
  if(code==='permission_denied')return 'You do not have authority to resolve decisions in this room.';
  const message=(problem as Error)?.message;
  return message?`Not resolved — ${message}`:'Not resolved. Nothing was sent.';
}

/**
 * What a person is being asked to authorise, in their own language.
 *
 * The action is a structured thing an agent proposed, and it used to be shown as the JSON it is:
 * braces, keys and a hash, in front of somebody deciding whether to allow it. The same content
 * reads as a name and a short list of plain fields, which is what the decision actually is. No
 * schema, no payload, no digest — and nothing here interprets or judges, it only reads out what
 * was proposed.
 */
export function actionSummary(proposed:Record<string,unknown>|null|undefined,limit=10){
  const naming=['action','type','name','operation','kind'];
  const entries=Object.entries(proposed??{});
  const named=entries.find(([key,value])=>naming.includes(key.toLowerCase())&&typeof value==='string');
  const fields:Array<[string,string]>=[];
  const walk=(value:unknown,path:string[])=>{
    if(fields.length>=limit)return;
    if(value===null||value===undefined){fields.push([label(path),'None']);return}
    if(Array.isArray(value)){
      const flat=value.filter(item=>item===null||typeof item!=='object');
      if(flat.length===value.length){fields.push([label(path),value.map(text).join(', ')||'None']);return}
      value.forEach((item,index)=>walk(item,[...path,String(index+1)]));
      return;
    }
    if(typeof value==='object'){
      for(const [key,inner] of Object.entries(value as Record<string,unknown>))walk(inner,[...path,key]);
      return;
    }
    fields.push([label(path),text(value)]);
  };
  for(const [key,value] of entries){
    if(named&&key===named[0])continue;
    walk(value,[key]);
  }
  const counted=countLeaves(proposed??{})-(named?1:0);
  return {headline:named?sentence(String(named[1])):null,fields,more:Math.max(0,counted-fields.length)};
}

const label=(path:string[])=>path.map(part=>sentence(part)).join(' · ');
/** A key or an action name as a sentence: one capital at the front, acronyms left alone. */
const sentence=(raw:string)=>{
  const words=raw.replace(/[_-]+/g,' ').replace(/([a-z\d])([A-Z])/g,'$1 $2').trim().split(/\s+/);
  if(!words.length||!words[0])return raw;
  return words.map((word,index)=>{
    if(word.length>1&&word===word.toUpperCase())return word;      // URL, ID, API
    return index===0?word.charAt(0).toUpperCase()+word.slice(1).toLowerCase():word.toLowerCase();
  }).join(' ');
};
const text=(value:unknown)=>typeof value==='boolean'?(value?'Yes':'No'):value===null||value===undefined?'None':String(value);
const countLeaves=(value:unknown):number=>{
  if(value===null||value===undefined||typeof value!=='object')return 1;
  if(Array.isArray(value))return value.some(item=>item&&typeof item==='object')?value.reduce<number>((total,item)=>total+countLeaves(item),0):1;
  return Object.values(value as Record<string,unknown>).reduce<number>((total,inner)=>total+countLeaves(inner),0);
};

export function DecisionCard({decision,requester,onResolve,focused=false}:{decision:Decision;requester?:Member;onResolve:(r:'approve'|'reject',note:string)=>Promise<void>;focused?:boolean}){
  const [note,setNote]=useState('');
  const [pending,setPending]=useState<'approve'|'reject'|null>(null);
  const [error,setError]=useState('');
  const [open,setOpen]=useState(false);
  const detail=useRef<HTMLDivElement>(null);
  // Opening replaces the control that was focused, so focus moves into what it revealed.
  useEffect(()=>{if(open)detail.current?.focus()},[open]);
  const who=requester?.display_name??'An agent';

  const act=async(result:'approve'|'reject')=>{
    if(pending)return;                       // one outcome in flight at a time
    setPending(result);setError('');
    try{await onResolve(result,note)}
    catch(problem){setError(resolutionProblem(problem));setPending(null)}
  };

  const action=actionSummary(decision.proposed_action);
  const card=useRef<HTMLElement>(null);
  // Opened from a notification: bring the decision into view once, where it can be answered.
  useEffect(()=>{if(focused)card.current?.scrollIntoView({block:'center'})},[focused]);
  return <article ref={card} id={`decision-${decision.id}`} className={`decision${focused?' focused':''}`} data-testid="decision-card">
    <div className="decision-head">
      <span className="decision-mark">Decision</span>
      <strong>{who}</strong>
      <time dateTime={decision.requested_at}>{formatTime(decision.requested_at)}</time>
    </div>
    <p className="decision-title">{decision.title}</p>

    {!open&&<button type="button" className="decision-review" onClick={()=>setOpen(true)}>Review<ChevronRight size={14}/></button>}

    {open&&<div className="decision-detail" ref={detail} tabIndex={-1}>
      <dl>
        <dt>What {who} wants to do</dt><dd>{decision.question}</dd>
        {decision.rationale&&<><dt>Why this needs you</dt><dd>{decision.rationale}</dd></>}
        <dt>Exactly what you are authorising</dt>
        <dd>
          {action.headline&&<p className="decision-action">{action.headline}</p>}
          {action.fields.length>0&&<ul className="decision-fields">
            {action.fields.map(([label,value])=><li key={label}><span>{label}</span><b>{value}</b></li>)}
          </ul>}
          {action.more>0&&<p className="decision-more">and {action.more} further {action.more===1?'detail':'details'}</p>}
          {!action.headline&&!action.fields.length&&<p className="decision-action">No further details were given.</p>}
          <span className="decision-locked">Approving authorises exactly this, and nothing else.</span>
        </dd>
        <dt>Requested by</dt><dd>{who}{requester?.kind==='agent'?' (agent)':''}</dd>
      </dl>
      <label className="instruction">
        <span>Note to {who}</span>
        <small>Sent with your decision. It does not change the action above.</small>
        <textarea value={note} onChange={event=>setNote(event.target.value)} placeholder="Add a condition or next step" rows={2} disabled={Boolean(pending)}/>
      </label>
      <p className="decision-after">{who} resumes on its own once you decide.</p>
      <div className="decision-actions">
        <button type="button" className="reject" disabled={Boolean(pending)} onClick={()=>void act('reject')}>
          <X size={15}/>{pending==='reject'?'Rejecting…':'Reject'}
        </button>
        <button type="button" className="approve" disabled={Boolean(pending)} onClick={()=>void act('approve')}>
          <Check size={15}/>{pending==='approve'?'Approving…':'Approve'}
        </button>
      </div>
    </div>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </article>
}

/** A task nobody can move without a person. Stated plainly, with no action invented for it. */
function BlockedItem({task,owner}:{task:Task;owner?:Member}){
  return <article className="blocked-item">
    <span className="blocked-mark">Blocked</span>
    <p className="blocked-title">{task.title}</p>
    <p className="blocked-who">{owner?`${owner.display_name} cannot continue`:'Unassigned'}</p>
  </article>
}

function TaskCreator({agents,onCreate}:{agents:Member[];onCreate:(x:{title:string;description:string;assigneePrincipalId?:string})=>Promise<void>}){
  const [open,setOpen]=useState(false),[title,setTitle]=useState(''),[description,setDescription]=useState(''),[owner,setOwner]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async(e:FormEvent)=>{e.preventDefault();if(!title.trim())return;setBusy(true);setError('');try{await onCreate({title:title.trim(),description:description.trim(),assigneePrincipalId:owner||undefined});setTitle('');setDescription('');setOpen(false)}catch(x){setError((x as Error).message)}finally{setBusy(false)}};
  if(!open)return <button className="add-task" onClick={()=>setOpen(true)}><Plus size={14}/>Add task</button>;
  return <form className="task-form" onSubmit={submit}><input autoFocus aria-label="Task title" placeholder="Task title" value={title} onChange={e=>setTitle(e.target.value)}/><textarea aria-label="Task description" placeholder="What does done look like?" value={description} onChange={e=>setDescription(e.target.value)} rows={2}/><select aria-label="Task owner" value={owner} onChange={e=>setOwner(e.target.value)}><option value="">Unassigned</option>{agents.map(a=><option value={a.principal_id} key={a.principal_id}>{a.display_name}</option>)}</select><div><button type="button" onClick={()=>setOpen(false)}>Cancel</button><button disabled={busy||!title.trim()}>Create task</button></div>{error&&<p className="form-error">{error}</p>}</form>
}

/** Every workspace the server says this person belongs to, with how they belong to it. */
function memberships(identity:SignedInIdentity){
  return identity.companies.map(company=>({
    companyId:company.company_id,
    name:company.company_name,
    accessScope:(company as {access_scope?:'workspace'|'room_only'}).access_scope??'workspace',
  }));
}

function RoomRoute({path,navigate}:{path:string;navigate:(to:string)=>void}){
  const room=useMemo(roomFromLocation,[path]);
  const [state,setState]=useState<{status:'loading'}|{status:'no_access'}|{status:'error';message:string}|{status:'ready';identity:RoomIdentity;workspace:{companyId:string;name:string};rooms:WorkspaceRoom[];userId:string}>({status:'loading'});
  useEffect(()=>{
    if(!room)return;
    let alive=true;
    void currentIdentity().then(me=>{
      if(!alive)return;
      // Signing in returns you here rather than dropping you somewhere generic.
      if(!me){rememberIntent(location.pathname);return navigate('/signin')}
      const membership=me.companies.find(c=>c.company_id===room.companyId);
      if(!membership)return setState({status:'no_access'});
      /* The room opens on its own membership, not on the room list.

         The list is what the sidebar draws; it is not what makes this room readable, and a person
         invited to a single room may not be allowed to enumerate the workspace at all. Waiting for
         it meant a failed or forbidden list left the room on "Opening the room…" for good. */
      setState({status:'ready',identity:{...room,principalId:membership.principal_id},
                workspace:{companyId:room.companyId,name:membership.company_name},
                rooms:[],userId:me.user.id});
      void listWorkspaceRooms(room.companyId)
        .then(rooms=>{if(alive)setState(current=>current.status==='ready'?{...current,rooms}:current)})
        .catch(()=>{/* the sidebar lists nothing; the room is already open */});
    }).catch(error=>{if(alive)setState({status:'error',message:(error as Error).message})});
    return()=>{alive=false};
  },[room?.companyId,room?.roomId,navigate]);

  if(!room)return <main className="route-error"><div className="brand-mark">M</div><h1>Room link incomplete</h1><p>Open a link that includes the company and the room.</p><code>/rooms/company-id/room-id</code></main>;
  if(state.status==='loading')return <main className="route-error"><div className="brand-mark">M</div><p className="auth-quiet">Opening the room…</p></main>;
  if(state.status==='no_access')return <main className="route-error"><div className="brand-mark">M</div><h1>No access to this workspace</h1><p>Your account is not a member of this company.</p></main>;
  if(state.status==='error')return <main className="route-error"><div className="brand-mark">M</div><h1>Something went wrong</h1><p>{state.message}</p></main>;
  // In a room the room is the whole window: its own header carries the way Home, so no bar above it.
  return <Shell bar={false} workspace={state.workspace} rooms={state.rooms} currentRoomId={room.roomId} onNavigate={navigate} onboardingKey={`${state.userId}:${state.workspace.companyId}`}>
    <Room identity={state.identity} workspace={state.workspace.name} onNavigate={navigate}/>
  </Shell>;
}

/**
 * Where a URL takes you.
 *
 * The root is a real entry point rather than a room link that failed to parse: signed out it is
 * the front door, signed in it is either onboarding or Home, decided by what the account actually
 * has. Every path here is registered with the server too, so a refresh never lands on a 404.
 */
function RoomApp(){
  const [path,setPath]=useState(()=>location.pathname);
  useEffect(()=>{
    const sync=()=>setPath(location.pathname);
    addEventListener('popstate',sync);
    return()=>removeEventListener('popstate',sync);
  },[]);
  const navigate=useCallback((to:string)=>{history.pushState({},'',to);setPath(new URL(to,location.origin).pathname)},[]);

  if(path==='/signin')return <SignIn/>;
  if(path==='/signup')return <SignUp onNavigate={navigate}/>;
  if(path==='/join')return <JoinRoom navigate={navigate}/>;
  if(path==='/welcome')return <Welcome navigate={navigate}/>;
  if(path==='/fixtures/presence')return <PresenceFixture/>;
  if(path==='/fixtures/decisions')return <DecisionFixture/>;
  if(path==='/'||path==='/home'||path==='/settings')return <Authenticated path={path} navigate={navigate}/>;
  return <RoomRoute path={path} navigate={navigate}/>;
}

/**
 * The signed-in pages, and the decision the root has to make. Which one you get is read from the
 * account itself — no workspace means there is still setting up to do, and a workspace means
 * there is somewhere to go.
 */
function Authenticated({path,navigate}:{path:string;navigate:(to:string)=>void}){
  const [state,setState]=useState<
    |{status:'loading'}
    |{status:'anonymous'}
    |{status:'ready';identity:SignedInIdentity;workspace:{companyId:string;name:string;accessScope:'workspace'|'room_only'}|null;rooms:WorkspaceRoom[]}>(
    {status:'loading'});

  useEffect(()=>{
    let alive=true;
    void (async()=>{
      const me=await currentIdentity().catch(()=>null);
      if(!alive)return;
      if(!me)return setState({status:'anonymous'});
      /* The first workspace is where this person's own things live, but it is not the only one
         they belong to: being invited to a single room makes them a room-only member of that
         room's workspace too. Home is handed all of them. */
      const company=me.companies.find((c:any)=>(c.access_scope??'workspace')!=='room_only')??me.companies[0];
      const workspace=company?{companyId:company.company_id,name:company.company_name,accessScope:company.access_scope??'workspace'}:null;
      const rooms=workspace?await listWorkspaceRooms(workspace.companyId).catch(()=>[]):[];
      if(!alive)return;
      setState({status:'ready',identity:me,workspace,rooms});
    })();
    return()=>{alive=false};
  },[path]);

  useEffect(()=>{
    if(state.status==='anonymous'&&path!=='/')navigate('/');
  },[state.status,path,navigate]);

  if(state.status==='loading')return <main className="loading-room"><div className="brand-mark">M</div><div className="loading-line"/><p>Loading…</p></main>;
  if(state.status==='anonymous')return <Entry onNavigate={navigate}/>;

  const inner=path==='/settings'
    ? state.workspace?<Settings identity={state.identity} workspace={state.workspace}/>:<Home workspace={null} onNavigate={navigate}/>
    : <Home workspace={state.workspace} memberships={memberships(state.identity)} onNavigate={navigate}/>;

  return <Shell workspace={state.workspace} rooms={state.rooms} onNavigate={navigate} onboardingKey={state.workspace?`${state.identity.user.id}:${state.workspace.companyId}`:undefined}>{inner}</Shell>;
}


function RoomContext({workspace,snapshot}:{workspace:string;snapshot:RoomSnapshot}){
  return <nav className="room-context" aria-label="Workspace context">
    <div className="context-block"><span className="context-label">Workspace</span><p className="context-value">{workspace}</p></div>
    <div className="context-block">
      <span className="context-label">Room</span>
      <p className="context-value context-room">{snapshot.room.name}</p>
      <p className="context-objective">{snapshot.briefing.project_objective}</p>
    </div>
  </nav>;
}

function ShareRoom({roomName,onCreate,onClose}:{roomName:string;onCreate:()=>Promise<{invite_path:string;expires_at:string}>;onClose:()=>void}){
  const [state,setState]=useState<{status:'creating'}|{status:'ready';url:string;expires:string;copied:boolean}|{status:'error';message:string}>({status:'creating'});
  useEffect(()=>{let alive=true;void onCreate().then(invite=>{if(alive)setState({status:'ready',url:new URL(invite.invite_path,location.origin).href,expires:invite.expires_at,copied:false})}).catch(problem=>{if(alive)setState({status:'error',message:(problem as Error).message})});return()=>{alive=false}},[onCreate]);
  const copy=async()=>{if(state.status!=='ready')return;await navigator.clipboard.writeText(state.url);setState({...state,copied:true})};
  return <div className="connect-overlay share-overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section className="connect-dialog share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-room-title">
      <button type="button" className="connect-close" aria-label="Close invitation" onClick={onClose}><X size={16}/></button>
      <h2 id="share-room-title">Invite someone to {roomName}</h2>
      <p>This single-use link adds one signed-in person to this room. It expires after 24 hours.</p>
      {state.status==='creating'&&<p className="auth-quiet" role="status">Creating a secure invitation…</p>}
      {state.status==='error'&&<p className="form-error" role="alert">{state.message}</p>}
      {state.status==='ready'&&<>
        <label className="field"><span className="field-label">Invitation link</span><input readOnly value={state.url} onFocus={event=>event.currentTarget.select()}/></label>
        <button className="copy-invite" onClick={()=>void copy()}><Copy size={15}/>{state.copied?'Copied':'Copy link'}</button>
        <small>Expires {new Date(state.expires).toLocaleString()}. The secret is never stored in readable form.</small>
      </>}
    </section>
  </div>;
}

function Room({identity,workspace,onNavigate}:{identity:RoomIdentity;workspace:string;onNavigate:(to:string)=>void}){
  const {api,snapshot,connection,lastEvent,error,refresh}=useRoomSession(identity);
  const [briefingOpen,setBriefingOpen]=useState(false);
  const [oversightOpen,setOversightOpen]=useState(false);
  const {confirm,dialog}=useConfirm();
  const oversightTrigger=useRef<HTMLButtonElement>(null);
  const oversightClose=useRef<HTMLButtonElement>(null);

  const [addressee,setAddressee]=useState('');
  const [composerFocus,setComposerFocus]=useState(0);
  const [connecting,setConnecting]=useState<Member|null>(null);
  const [sharing,setSharing]=useState(false);
  /* Which agent record an action addresses, and whether it is paused, are company-level facts
     the room snapshot does not carry. They are refetched whenever the room reports an agent
     changing, so a pause made here or elsewhere is reflected without polling. */
  const [companyAgents,setCompanyAgents]=useState<CompanyAgent[]>([]);
  const loadAgents=useCallback(()=>{void api.companyAgents().then(setCompanyAgents).catch(()=>{})},[api]);
  useEffect(loadAgents,[loadAgents]);
  const agentEventSeq=lastEvent&&lastEvent.event_type.startsWith('agent.')?lastEvent.room_seq:0;
  useEffect(()=>{if(agentEventSeq)loadAgents()},[agentEventSeq,loadAgents]);

  /* Read is what this person has actually had in front of them: the room open, the window focused
     and the tab visible. Only then does its read position move, and only forward. */
  const latestSeq=Math.max(snapshot?.snapshot_seq??0,lastEvent?.room_seq??0);
  const readSeq=useRef(0);
  /* Read means reached: the newest message has been on screen, not merely the room opened above it. */
  const [atLatest,setAtLatest]=useState(true);
  /* Where this person had read to when they came in, captured in the same render the room first
     arrives. Set later, the transcript had already placed itself before it knew where unread began. */
  const opening=useRef<number|null|undefined>(undefined);
  if(opening.current===undefined&&snapshot){
    opening.current=snapshot.read_positions?.find(p=>p.principal_id===identity.principalId)?.last_read_seq??null;
  }
  const openingReadSeq=opening.current;
  useEffect(()=>{
    if(!latestSeq||!atLatest)return;
    let timer:number|undefined;
    const mark=()=>{
      // Visible is read. Keyboard focus is not required: inside the Mac app focus often sits outside
      // the page while the person is plainly looking at the room, and the room then never cleared.
      if(document.visibilityState!=='visible'||latestSeq<=readSeq.current)return;
      window.clearTimeout(timer);
      timer=window.setTimeout(()=>{readSeq.current=Math.max(readSeq.current,latestSeq);void api.markRead(latestSeq).catch(()=>{readSeq.current=0})},400);
    };
    mark();
    window.addEventListener('focus',mark);document.addEventListener('visibilitychange',mark);
    return()=>{window.clearTimeout(timer);window.removeEventListener('focus',mark);document.removeEventListener('visibilitychange',mark)};
  },[latestSeq,api,atLatest]);
  /* Who has read what, for receipts. Reading moves no room event, so it is asked for again every
     so often while the room is on screen, and whenever the room itself changes. */
  const [readPositions,setReadPositions]=useState<ReadPosition[]>([]);
  useEffect(()=>{if(snapshot?.read_positions)setReadPositions(snapshot.read_positions)},[snapshot]);
  useEffect(()=>{
    let live=true;
    const load=()=>{if(document.visibilityState==='visible')void api.readPositions().then(r=>{if(live)setReadPositions(r.read_positions)}).catch(()=>{})};
    const timer=window.setInterval(load,15_000);
    return()=>{live=false;window.clearInterval(timer)};
  },[api]);
  /* A notification about a decision opens the panel it waits in. */
  useEffect(()=>{if(/^#decision-/i.test(location.hash))setOversightOpen(true)},[]);

  const closeOversight=useCallback(()=>{setOversightOpen(false);oversightTrigger.current?.focus()},[]);
  useEffect(()=>{
    if(!oversightOpen)return;
    // Focus moves into the panel as it opens; the retry covers the frame in which the panel
    // is still being made visible.
    const focus=()=>oversightClose.current?.focus();
    focus();
    const frame=requestAnimationFrame(focus);
    const onKey=(event:KeyboardEvent)=>{if(event.key==='Escape')closeOversight()};
    addEventListener('keydown',onKey);
    return()=>{cancelAnimationFrame(frame);removeEventListener('keydown',onKey)};
  },[oversightOpen,closeOversight]);

  if(!snapshot)return <main className="loading-room"><div className="brand-mark">M</div><div className="loading-line"/><p>{error??'Entering the room…'}</p>{error&&<button onClick={()=>void refresh()}><RefreshCw size={15}/>Try again</button>}</main>;
  const current=snapshot.members.find(m=>m.principal_id===identity.principalId);
  const managers=current?.role==='manager';const agents=snapshot.members.filter(m=>m.kind==='agent');const pending=snapshot.briefing.unresolved_decisions;
  const recent=snapshot.briefing.important_recent_activity;
  /* Who owns which agent, for the one place it tells a person something they do not know: choosing
     between agents belonging to different people. Their own agents are not labelled as theirs —
     every card saying "your agent" to you is a line that never varies and never informs. Ownership
     itself is unchanged and still recorded; this is only about what is worth showing. */
  const ownerNames:Record<string,string[]>={};
  for(const rel of snapshot.relationships??[])
    if(rel.human_principal_id!==identity.principalId)(ownerNames[rel.agent_principal_id]??=[]).push(rel.human_display_name);
  const mutate=async(action:()=>Promise<unknown>)=>{await action();await refresh()};
  /* Every consequential change is an explicit, named command against a real primitive. There is
     no intent parsing: what the person pressed is what is sent. */
  const actions:WorkActions={
    setStatus:(task,status)=>mutate(()=>api.updateTask(task.id,status,task.version)),
    reassign:(task,to)=>mutate(()=>api.reassignTask(task.id,to,task.version)),
    addDependency:(task,dependsOn)=>mutate(()=>api.addDependency(task.id,dependsOn)),
    removeDependency:(task,dependsOn)=>mutate(()=>api.removeDependency(task.id,dependsOn)),
    override:(task,reason)=>mutate(()=>api.overrideDependencies(task.id,reason)),
    pause:agent=>mutate(()=>api.pauseAgent(agent.agent_id)).then(loadAgents),
    resume:agent=>mutate(()=>api.resumeAgent(agent.agent_id)).then(loadAgents),
  };
  /* One path, whether the agent is new to the workspace or only new to this room: it ends as a
     member here, and then the same connect flow the rest of the product uses. */
  const addAgentToRoom=async(choice:{name?:string;principalId?:string})=>{
    if(choice.principalId){
      // Re-read authoritative binding before consent; Cancel performs no mutation.
      const agent=(await listWorkspaceAgents(identity.companyId)).find(a=>a.principal_id===choice.principalId);
      const move=agent&&agentRoomMove(agent,identity.companyId,identity.roomId,snapshot.room.name);
      if(move){
        confirm({title:'Move agent?',detail:move.message,action:'Move agent',run:async()=>{
          handoffAgentMove(move,()=>true,url=>{window.location.href=url});
        }});
        return;
      }
    }
    const principalId=choice.principalId
      ?? (await addWorkspaceAgent(identity.companyId,choice.name!.trim())).principal_id;
    await addRoomMember(identity.companyId,identity.roomId,principalId,'');
    await refresh();
    loadAgents();
    /* An agent that already has a Mac connects from that Mac, with what it already holds. Offering
       it a code here asked for a new credential it did not need. */
    const existing=choice.principalId?(await listWorkspaceAgents(identity.companyId)).find(a=>a.principal_id===principalId):undefined;
    const onMac=existing&&connectOnMac(existing,identity.companyId,identity.roomId);
    if(onMac){window.location.href=onMac;return}
    // Offer the connect step straight away, from what the room now reports.
    const joined=(await api.snapshot()).members.find(m=>m.principal_id===principalId);
    if(joined)setConnecting(joined);
  };
  const messageAgent=(principalId:string)=>{setAddressee(principalId);setComposerFocus(n=>n+1);setOversightOpen(false)};
  // Every number in the mobile trigger is counted from state already known to be true.
  const openWork=snapshot.tasks.filter(t=>!['completed','cancelled'].includes(t.status));
  const blocked=openWork.filter(t=>t.status==='blocked');
  /* Needs You is work that has stopped and that only a person can restart. A decision appears
     only for someone who can actually resolve it, and nothing merely informational — an agent
     going quiet, a message arriving — ever qualifies. */
  const needsYou={
    decisions:managers?pending:[],
    blocked:managers?blocked:[],
    total:managers?pending.length+blocked.length:0,
  };
  const working=agents.filter(a=>a.agent_presence==='connected'&&a.agent_runtime_status==='working');
  const attention=needsYou.total;
  const connectingRecord=connecting&&companyAgents.find(agent=>agent.principal_id===connecting.principal_id);
  const enrollmentAgent:WorkspaceAgent|null=connecting&&connectingRecord?{
    agent_id:connectingRecord.agent_id,principal_id:connecting.principal_id,display_name:connecting.display_name,
    status:connectingRecord.status,owner_display_name:null,
    connector:{enrolled:Boolean(connectingRecord.connector_enrolled),presence:connecting.agent_presence??'never',
      runtime_status:connecting.agent_runtime_status??null,last_seen_at:connecting.agent_last_seen_at??null,
      // Built from the room's own view, so the session it describes is this room's by construction.
      room_id:identity.roomId,room_name:snapshot.room.name},
    rooms:[{room_id:identity.roomId,name:snapshot.room.name}],
  }:null;

  return <main className="room-app">
    {dialog}
    <header className="room-header"><button type="button" className="brand-mark home-button" aria-label="Home" title="Home" onClick={()=>onNavigate('/home')}>M</button><div className="room-title"><span>{snapshot.room.project_name}</span><h1>{snapshot.room.name}</h1></div><div className="objective"><span>Objective</span><p>{snapshot.room.objective}</p></div>{managers&&<><button className="share-room" onClick={()=>setSharing(true)}><Share2 size={14}/>Share</button><button className="delete-room" onClick={()=>confirm({title:`Delete ${snapshot.room.name}?`,detail:'Everyone loses access, and any agent sessions and credentials scoped to this room are revoked. The room history is kept.',action:'Delete room',run:async()=>{await deleteWorkspaceRoom(identity.companyId,identity.roomId);onNavigate('/home')}})}>Delete room</button></>}<RoomNotifications companyId={identity.companyId} roomId={identity.roomId}/><button className="briefing-toggle" onClick={()=>setBriefingOpen(!briefingOpen)} aria-expanded={briefingOpen}>Briefing <ChevronDown size={14}/></button><Connection state={connection}/></header>
    {briefingOpen&&<section className="briefing"><div><span>Normalized room briefing</span><h2>{snapshot.briefing.project_objective}</h2></div><dl><div><dt>Your role</dt><dd>{snapshot.briefing.joining_principal.role}</dd></div><div><dt>Your responsibility</dt><dd>{snapshot.briefing.joining_principal.responsibilities||'Contribute to the room objective'}</dd></div><div><dt>Active work</dt><dd>{snapshot.briefing.active_tasks.length} tasks · {snapshot.briefing.blockers.length} blocked</dd></div></dl></section>}
    {connection==='revoked'&&<div className="revoked-screen" role="alert"><ShieldAlert/><h2>Room access removed</h2><p>{error}</p></div>}
    <div className="worktable" aria-hidden={connection==='revoked'}>
      <RoomContext workspace={workspace} snapshot={snapshot}/>
      <section className="conversation" aria-label="Live room conversation"><div className="section-heading"><div><span>Room conversation</span><strong>Shared, visible, durable</strong></div></div><Transcript api={api} currentId={identity.principalId} readPositions={readPositions} openingReadSeq={openingReadSeq} onAtLatest={setAtLatest} messages={snapshot.messages} members={snapshot.members} events={recent} lastEvent={lastEvent}/><AttachmentComposer api={api} members={snapshot.members.filter(m=>m.principal_id!==identity.principalId)} onSend={(body,to,ids,key,mentions)=>mutate(()=>api.sendMessage(body,to,ids,key,mentions))} ownerNames={ownerNames} to={addressee} onAddressee={setAddressee} focusToken={composerFocus}/></section>
      <aside className="supervision" aria-label="Live team and human oversight" data-open={oversightOpen}>
        <div className="sheet-bar">
          <span>Team &amp; work</span>
          <button ref={oversightClose} onClick={closeOversight} aria-label="Close team and work"><X size={16}/></button>
        </div>
        <div className="supervision-scroll">
          {/* Only for people a decision can actually be addressed to: a contributor cannot
              resolve one, and a section of things that will never need them is noise. */}
          {managers&&<section className="needs-you" data-onboarding="needs-you">
          <div className="section-label"><span>Needs you</span><b>{needsYou.total}</b></div>
          {needsYou.decisions.map(d=><DecisionCard key={d.id} focused={location.hash===`#decision-${d.id}`} decision={d} requester={snapshot.members.find(m=>m.principal_id===d.requested_by_principal_id)} onResolve={(result,note)=>mutate(()=>api.resolveDecision(d,result,note))}/>)}
          {needsYou.blocked.map(t=><BlockedItem key={t.id} task={t} owner={snapshot.members.find(m=>m.principal_id===t.assignee_principal_id)}/>)}
          {needsYou.total===0&&<p className="small-empty">No decisions or approvals need you.</p>}
        </section>}
          <Participants members={snapshot.members} ownerNames={ownerNames} currentId={identity.principalId} tasks={snapshot.tasks} decisions={pending}
            companyAgents={companyAgents} canManage={managers} actions={actions} onMessage={messageAgent} onConnect={setConnecting}
            onDisconnect={member=>mutate(()=>api.disconnectMember(member.principal_id)).then(()=>undefined)}
            onRemove={member=>mutate(()=>api.removeMember(member.principal_id)).then(()=>{loadAgents()})}
            onAddAgent={addAgentToRoom}/>
          <SharedWork tasks={snapshot.tasks} members={snapshot.members} agents={agents} canManage={managers} currentId={identity.principalId} actions={actions}>
            <TaskCreator agents={agents} onCreate={x=>mutate(()=>api.createTask(x))}/>
          </SharedWork>
          <RoomFiles api={api} sequence={snapshot.snapshot_seq}/>
          <details className="activity" data-onboarding="live-activity"><summary className="section-label"><span>Live activity</span></summary><ol>{recent.filter(e=>e.event_type!=='message.sent').slice(-5).reverse().map(e=><li key={e.room_seq}><span className={`event-dot ${e.actor_kind}`}/><p><strong>{e.actor_display_name}</strong> {activityText(e)}</p><time>{formatTime(e.created_at)}</time></li>)}</ol></details>
        </div>
      </aside>
      {oversightOpen&&<button type="button" className="sheet-scrim" aria-label="Close team and work" onClick={closeOversight}/>}
    </div>
    <button ref={oversightTrigger} className="oversight-trigger" onClick={()=>setOversightOpen(true)} aria-expanded={oversightOpen}>
      <span className="trigger-team">{agents.length} {agents.length===1?'agent':'agents'}{working.length?` · ${working.length} working`:''}</span>
      {attention>0&&<span className="trigger-attention">{attention} needs you</span>}
    </button>
    {enrollmentAgent&&<div className="connect-overlay" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)setConnecting(null)}}>
      <section className="connect-dialog" role="dialog" aria-modal="true" aria-labelledby="connect-agent-title">
        <button type="button" className="connect-close" aria-label="Close connection setup" onClick={()=>setConnecting(null)}><X size={16}/></button>
        <h2 id="connect-agent-title">Connect {enrollmentAgent.display_name}</h2>
        <p>Open Multiplayer AI on the machine where this agent runs.</p>
        {/* The room being looked at is the room the code is for. Anything else is how an agent
            connected from one room ends up bound to another. */}
        <ConnectAgent companyId={identity.companyId} roomId={identity.roomId}
          roomName={snapshot.room.name} agent={enrollmentAgent} onChanged={loadAgents}/>
      </section>
    </div>}
    {sharing&&<ShareRoom roomName={snapshot.room.name} onCreate={()=>api.createInvite()} onClose={()=>setSharing(false)}/>}
    <div className="sr-live" aria-live="polite">{lastEvent&&`${lastEvent.actor_display_name} ${activityText(lastEvent)}`}</div>
  </main>;
}

export default RoomApp;
