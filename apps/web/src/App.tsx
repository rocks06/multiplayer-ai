import {memo,useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {ArrowUp,Check,ChevronDown,ChevronRight,Clock3,Plus,RefreshCw,ShieldAlert,Users,X} from 'lucide-react';
import {ApiError,currentIdentity,roomFromLocation} from './api';
import SignIn,{rememberIntent} from './SignIn';
import PresenceFixture from './PresenceFixture';
import DecisionFixture from './DecisionFixture';
import {AgentControls,SharedWork,type WorkActions} from './Work';
import {describePresence,elapsedLabel,type AgentPresence} from './presence';
import {useRoomSession} from './use-room';
import type {CompanyAgent,ConnectionState,Decision,Member,Message,RoomEvent,RoomIdentity,RoomSnapshot,Task,TaskStatus} from './types';
import './styles.css';

const formatTime=(value:string)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(value));

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

export function Participants({members,currentId,tasks,decisions,companyAgents,canManage,actions,onMessage}:{
  members:Member[];currentId:string;tasks:Task[];decisions:Decision[];
  companyAgents?:CompanyAgent[];canManage?:boolean;actions?:WorkActions;onMessage?:(principalId:string)=>void}){
  const humans=members.filter(m=>m.kind==='human'),agents=members.filter(m=>m.kind==='agent');
  // Only agents that are not currently reachable carry an elapsed reading, so the clock runs
  // only when something on screen actually depends on it.
  const presences=agents.map(agent=>({agent,presence:describePresence(agent,{tasks,decisions,members})}));
  const now=useCoarseNow(presences.some(entry=>entry.presence.since));
  return <aside className="participants" aria-label="Room participants">
    <div className="rail-heading"><Users size={15}/><span>In this room</span><b>{members.length}</b></div>
    <section><h2>People</h2><ul>{humans.map(m=><HumanRow key={m.principal_id} member={m} current={m.principal_id===currentId}/>)}</ul></section>
    <section><h2>Agents</h2><ul>{presences.map(({agent,presence})=>{
      const record=companyAgents?.find(a=>a.principal_id===agent.principal_id);
      return <li className="person-row" key={agent.principal_id}>
        <PresenceRow name={agent.display_name} initial={agent.display_name.slice(0,1).toUpperCase()}
          label={presence.label} tone={presence.tone} detail={presence.detail} paused={record?.status==='paused'}
          elapsed={elapsedLabel(presence.since,now)} lastSeenAt={agent.agent_last_seen_at??undefined}/>
        {actions&&onMessage&&
          <AgentControls member={agent} agent={record} canManage={Boolean(canManage)} actions={actions} onMessage={onMessage}/>}
      </li>;
    })}</ul></section>
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
    // Only claim a reply exists; claim who it answers only when that message is loaded.
    reply:message.in_reply_to_message_id?{sender:parent?.sender_name,excerpt:parent?.body_text,id:message.in_reply_to_message_id}:undefined,
    direction:message.sender_kind==='agent'?(addressee?.kind==='human'?'to-human':between?'between-agents':'broadcast'):(addressee?'to-agent':'broadcast'),
  };
}

const DECISION_VERBS:Record<string,string>={'decision.requested':'asked for a decision','decision.approved':'approved','decision.rejected':'rejected','decision.cancelled':'cancelled a decision','decision.expired':'decision expired'};

function Transcript({messages,members,events,lastEvent}:{messages:Message[];members:Member[];events:RoomEvent[];lastEvent:RoomEvent|null}){
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

  useEffect(()=>{const el=listRef.current;if(!el)return;const near=el.scrollHeight-el.scrollTop-el.clientHeight<100;if(near)scrollTranscript(el,el.scrollHeight);else setUnseen(n=>n+1)},[count]);
  const jump=()=>{const el=listRef.current;if(el)scrollTranscript(el,el.scrollHeight);setUnseen(0)};

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
    <div className="transcript" ref={listRef} data-testid="transcript">
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
        return <article
          className={`message ${message.sender_kind} ${rel.direction} ${same?'continued':''} ${focusedReply===message.id?'reply-target':''}`}
          key={message.id} data-message-id={message.id}>
          {!same&&<header>
            <span className={`sender-glyph ${message.sender_kind}`}>{message.sender_name.slice(0,1)}</span>
            <strong>{message.sender_name}</strong>
            <span className="kind-mark">{message.sender_kind==='agent'?'AI':'Human'}</span>
            <time dateTime={message.created_at}>{formatTime(message.created_at)}</time>
          </header>}
          <div className="message-body">
            {rel.reply&&(rel.reply.excerpt
              ? <button type="button" className="reply-cue" onClick={event=>followReply(rel.reply!.id,event.currentTarget)}>
                  <span className="reply-who">Replying to {rel.reply.sender}</span>
                  <span className="reply-excerpt">{rel.reply.excerpt}</span>
                </button>
              : <span className="reply-cue static"><span className="reply-who">Replying to an earlier message</span></span>)}
            {rel.showAddress&&<span className={`address ${rel.addressee?.kind}`}>To {rel.addressee?.display_name}</span>}
            <p>{message.body_text}</p>
          </div>
        </article>})}
    </div>
    {unseen>0&&<button type="button" className="new-items" onClick={jump}>{unseen} new {unseen===1?'update':'updates'} <ArrowUp size={13}/></button>}
  </div>
}

function Composer({members,onSend,to,onAddressee,focusToken}:{members:Member[];onSend:(body:string,to?:string)=>Promise<void>;to:string;onAddressee:(id:string)=>void;focusToken:number}){
  const [body,setBody]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const field=useRef<HTMLTextAreaElement>(null);
  // Choosing to message an agent should land the person in the box, ready to write.
  useEffect(()=>{if(focusToken)field.current?.focus()},[focusToken]);
  const submit=async(e?:FormEvent)=>{e?.preventDefault();if(!body.trim()||busy)return;setBusy(true);setError('');try{await onSend(body.trim(),to||undefined);setBody('')}catch(x){setError((x as Error).message)}finally{setBusy(false)}};
  return <form className="composer" onSubmit={submit} aria-label="Send a room message">
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

export function DecisionCard({decision,requester,onResolve}:{decision:Decision;requester?:Member;onResolve:(r:'approve'|'reject',note:string)=>Promise<void>}){
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

  return <article className="decision" data-testid="decision-card">
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
          <pre>{JSON.stringify(decision.proposed_action,null,2)}</pre>
          <span className="digest" title={decision.proposed_action_digest}>Locked to this exact action · {decision.proposed_action_digest.slice(0,12)}</span>
        </dd>
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

function RoomRoute({navigate}:{navigate:(to:string)=>void}){
  const room=useMemo(roomFromLocation,[]);
  const [state,setState]=useState<{status:'loading'}|{status:'no_access'}|{status:'error';message:string}|{status:'ready';identity:RoomIdentity;workspace:string}>({status:'loading'});
  useEffect(()=>{
    if(!room)return;
    let alive=true;
    void currentIdentity().then(me=>{
      if(!alive)return;
      // Signing in returns you here rather than dropping you somewhere generic.
      if(!me){rememberIntent(location.pathname);return navigate('/signin')}
      const membership=me.companies.find(c=>c.company_id===room.companyId);
      if(!membership)return setState({status:'no_access'});
      setState({status:'ready',identity:{...room,principalId:membership.principal_id},workspace:membership.company_name});
    }).catch(error=>{if(alive)setState({status:'error',message:(error as Error).message})});
    return()=>{alive=false};
  },[room?.companyId,room?.roomId,navigate]);

  if(!room)return <main className="route-error"><div className="brand-mark">M</div><h1>Room link incomplete</h1><p>Open a link that includes the company and the room.</p><code>/rooms/company-id/room-id</code></main>;
  if(state.status==='loading')return <main className="route-error"><div className="brand-mark">M</div><p className="auth-quiet">Opening the room…</p></main>;
  if(state.status==='no_access')return <main className="route-error"><div className="brand-mark">M</div><h1>No access to this workspace</h1><p>Your account is not a member of this company.</p></main>;
  if(state.status==='error')return <main className="route-error"><div className="brand-mark">M</div><h1>Something went wrong</h1><p>{state.message}</p></main>;
  return <Room identity={state.identity} workspace={state.workspace}/>;
}

function RoomApp(){
  const [path,setPath]=useState(()=>location.pathname);
  useEffect(()=>{
    const sync=()=>setPath(location.pathname);
    addEventListener('popstate',sync);
    return()=>removeEventListener('popstate',sync);
  },[]);
  const navigate=useCallback((to:string)=>{history.pushState({},'',to);setPath(new URL(to,location.origin).pathname)},[]);
  if(path==='/signin')return <SignIn/>;
  if(path==='/fixtures/presence')return <PresenceFixture/>;
  if(path==='/fixtures/decisions')return <DecisionFixture/>;
  return <RoomRoute navigate={navigate}/>;
}


function RoomContext({workspace,snapshot}:{workspace:string;snapshot:RoomSnapshot}){
  return <nav className="room-context" aria-label="Workspace context">
    <div className="context-block"><span className="context-label">Workspace</span><p className="context-value">{workspace}</p></div>
    <div className="context-block"><span className="context-label">Project</span><p className="context-value">{snapshot.room.project_name}</p></div>
    <div className="context-block">
      <span className="context-label">Room</span>
      <p className="context-value context-room">{snapshot.room.name}</p>
      <p className="context-objective">{snapshot.briefing.project_objective}</p>
    </div>
  </nav>;
}

function Room({identity,workspace}:{identity:RoomIdentity;workspace:string}){
  const {api,snapshot,connection,lastEvent,error,refresh}=useRoomSession(identity);
  const [briefingOpen,setBriefingOpen]=useState(false);
  const [oversightOpen,setOversightOpen]=useState(false);
  const oversightTrigger=useRef<HTMLButtonElement>(null);
  const oversightClose=useRef<HTMLButtonElement>(null);

  const [addressee,setAddressee]=useState('');
  const [composerFocus,setComposerFocus]=useState(0);
  /* Which agent record an action addresses, and whether it is paused, are company-level facts
     the room snapshot does not carry. They are refetched whenever the room reports an agent
     changing, so a pause made here or elsewhere is reflected without polling. */
  const [companyAgents,setCompanyAgents]=useState<CompanyAgent[]>([]);
  const loadAgents=useCallback(()=>{void api.companyAgents().then(setCompanyAgents).catch(()=>{})},[api]);
  useEffect(loadAgents,[loadAgents]);
  const agentEventSeq=lastEvent&&lastEvent.event_type.startsWith('agent.')?lastEvent.room_seq:0;
  useEffect(()=>{if(agentEventSeq)loadAgents()},[agentEventSeq,loadAgents]);

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

  return <main className="room-app">
    <header className="room-header"><div className="brand-mark">M</div><div className="room-title"><span>{snapshot.room.project_name}</span><h1>{snapshot.room.name}</h1></div><div className="objective"><span>Objective</span><p>{snapshot.room.objective}</p></div><button className="briefing-toggle" onClick={()=>setBriefingOpen(!briefingOpen)} aria-expanded={briefingOpen}>Briefing <ChevronDown size={14}/></button><Connection state={connection}/></header>
    {briefingOpen&&<section className="briefing"><div><span>Normalized room briefing</span><h2>{snapshot.briefing.project_objective}</h2></div><dl><div><dt>Your role</dt><dd>{snapshot.briefing.joining_principal.role}</dd></div><div><dt>Your responsibility</dt><dd>{snapshot.briefing.joining_principal.responsibilities||'Contribute to the room objective'}</dd></div><div><dt>Active work</dt><dd>{snapshot.briefing.active_tasks.length} tasks · {snapshot.briefing.blockers.length} blocked</dd></div></dl></section>}
    {connection==='revoked'&&<div className="revoked-screen" role="alert"><ShieldAlert/><h2>Room access removed</h2><p>{error}</p></div>}
    <div className="worktable" aria-hidden={connection==='revoked'}>
      <RoomContext workspace={workspace} snapshot={snapshot}/>
      <section className="conversation" aria-label="Live room conversation"><div className="section-heading"><div><span>Room conversation</span><strong>Shared, visible, durable</strong></div><span className="sequence">SEQ {snapshot.snapshot_seq}</span></div><Transcript messages={snapshot.messages} members={snapshot.members} events={recent} lastEvent={lastEvent}/><Composer members={snapshot.members.filter(m=>m.principal_id!==identity.principalId)} onSend={(body,to)=>mutate(()=>api.sendMessage(body,to))} to={addressee} onAddressee={setAddressee} focusToken={composerFocus}/></section>
      <aside className="supervision" aria-label="Live team and human oversight" data-open={oversightOpen}>
        <div className="sheet-bar">
          <span>Team &amp; work</span>
          <button ref={oversightClose} onClick={closeOversight} aria-label="Close team and work"><X size={16}/></button>
        </div>
        <div className="supervision-scroll">
          {needsYou.total>0&&<section className="needs-you">
          <div className="section-label"><span>Needs you</span><b>{needsYou.total}</b></div>
          {needsYou.decisions.map(d=><DecisionCard key={d.id} decision={d} requester={snapshot.members.find(m=>m.principal_id===d.requested_by_principal_id)} onResolve={(result,note)=>mutate(()=>api.resolveDecision(d,result,note))}/>)}
          {needsYou.blocked.map(t=><BlockedItem key={t.id} task={t} owner={snapshot.members.find(m=>m.principal_id===t.assignee_principal_id)}/>)}
        </section>}
          <Participants members={snapshot.members} currentId={identity.principalId} tasks={snapshot.tasks} decisions={pending}
            companyAgents={companyAgents} canManage={managers} actions={actions} onMessage={messageAgent}/>
          <SharedWork tasks={snapshot.tasks} members={snapshot.members} agents={agents} canManage={managers} currentId={identity.principalId} actions={actions}>
            <TaskCreator agents={agents} onCreate={x=>mutate(()=>api.createTask(x))}/>
          </SharedWork>
          <details className="activity"><summary className="section-label"><span>Room activity</span></summary><ol>{recent.filter(e=>e.event_type!=='message.sent').slice(-5).reverse().map(e=><li key={e.room_seq}><span className={`event-dot ${e.actor_kind}`}/><p><strong>{e.actor_display_name}</strong> {activityText(e)}</p><time>{formatTime(e.created_at)}</time></li>)}</ol></details>
        </div>
      </aside>
      {oversightOpen&&<button type="button" className="sheet-scrim" aria-label="Close team and work" onClick={closeOversight}/>}
    </div>
    <button ref={oversightTrigger} className="oversight-trigger" onClick={()=>setOversightOpen(true)} aria-expanded={oversightOpen}>
      <span className="trigger-team">{agents.length} {agents.length===1?'agent':'agents'}{working.length?` · ${working.length} working`:''}</span>
      {attention>0&&<span className="trigger-attention">{attention} needs you</span>}
    </button>
    <div className="sr-live" aria-live="polite">{lastEvent&&`${lastEvent.actor_display_name} ${activityText(lastEvent)}`}</div>
  </main>;
}

export default RoomApp;
