import {memo,useCallback,useEffect,useMemo,useRef,useState,type FormEvent} from 'react';
import {ArrowUp,Check,ChevronDown,ChevronRight,Clock3,Plus,RefreshCw,ShieldAlert,Users,X} from 'lucide-react';
import {currentIdentity,roomFromLocation} from './api';
import SignIn,{rememberIntent} from './SignIn';
import PresenceFixture from './PresenceFixture';
import {describePresence,elapsedLabel,type AgentPresence} from './presence';
import {useRoomSession} from './use-room';
import type {ConnectionState,Decision,Member,Message,RoomEvent,RoomIdentity,RoomSnapshot,Task,TaskStatus} from './types';
import './styles.css';

const formatTime=(value:string)=>new Intl.DateTimeFormat(undefined,{hour:'numeric',minute:'2-digit'}).format(new Date(value));
const labels:Record<TaskStatus,string>={open:'Open',in_progress:'In progress',blocked:'Blocked',awaiting_decision:'Waiting for human',completed:'Completed',cancelled:'Cancelled'};
const transitions:Record<TaskStatus,TaskStatus[]>={open:['in_progress','cancelled'],in_progress:['blocked','awaiting_decision','completed','cancelled'],blocked:['in_progress','cancelled'],awaiting_decision:['in_progress','cancelled'],completed:[],cancelled:[]};

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
const PresenceRow=memo(function PresenceRow({name,initial,label,tone,detail,elapsed,lastSeenAt}:{name:string;initial:string;label:string;tone:string;detail?:string;elapsed:string|null;lastSeenAt?:string}){
  return <li className="person-row">
    <span className="identity-mark agent" aria-hidden="true">{initial}</span>
    <span className="person-copy">
      <strong>{name}</strong>
      <small className="person-state">
        <span className={`state-dot ${tone}`} aria-hidden="true"/>
        <span className="state-label">{label}</span>
        {elapsed&&<span className="state-since" title={lastSeenAt}>{elapsed}</span>}
      </small>
      {detail&&<small className="person-detail">{detail}</small>}
    </span>
  </li>;
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

export function Participants({members,currentId,tasks,decisions}:{members:Member[];currentId:string;tasks:Task[];decisions:Decision[]}){
  const humans=members.filter(m=>m.kind==='human'),agents=members.filter(m=>m.kind==='agent');
  // Only agents that are not currently reachable carry an elapsed reading, so the clock runs
  // only when something on screen actually depends on it.
  const presences=agents.map(agent=>({agent,presence:describePresence(agent,{tasks,decisions,members})}));
  const now=useCoarseNow(presences.some(entry=>entry.presence.since));
  return <aside className="participants" aria-label="Room participants">
    <div className="rail-heading"><Users size={15}/><span>In this room</span><b>{members.length}</b></div>
    <section><h2>People</h2><ul>{humans.map(m=><HumanRow key={m.principal_id} member={m} current={m.principal_id===currentId}/>)}</ul></section>
    <section><h2>Agents</h2><ul>{presences.map(({agent,presence})=>
      <PresenceRow key={agent.principal_id} name={agent.display_name} initial={agent.display_name.slice(0,1).toUpperCase()}
        label={presence.label} tone={presence.tone} detail={presence.detail}
        elapsed={elapsedLabel(presence.since,now)} lastSeenAt={agent.agent_last_seen_at??undefined}/>)}</ul></section>
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

function Transcript({messages,members,lastEvent}:{messages:Message[];members:Member[];lastEvent:RoomEvent|null}){
  const byId=useMemo(()=>new Map(messages.map(m=>[m.id,m])),[messages]);
  const listRef=useRef<HTMLDivElement>(null);
  const [unseen,setUnseen]=useState(0);
  const [focusedReply,setFocusedReply]=useState<string|null>(null);
  const count=messages.length;

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
      {!messages.length&&<div className="empty"><strong>The room is ready.</strong><p>Start with a clear direction or assign the first piece of work.</p></div>}
      {messages.map((message,index)=>{
        // Grouping only hides a repeated name; it never implies a relationship.
        const same=index>0&&messages[index-1]?.sender_principal_id===message.sender_principal_id;
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
    {unseen>0&&<button className="new-items" onClick={jump}>{unseen} new {unseen===1?'update':'updates'} <ArrowUp size={13}/></button>}
  </div>
}

function Composer({members,onSend}:{members:Member[];onSend:(body:string,to?:string)=>Promise<void>}){
  const [body,setBody]=useState(''),[to,setTo]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const submit=async(e?:FormEvent)=>{e?.preventDefault();if(!body.trim()||busy)return;setBusy(true);setError('');try{await onSend(body.trim(),to||undefined);setBody('')}catch(x){setError((x as Error).message)}finally{setBusy(false)}};
  return <form className="composer" onSubmit={submit} aria-label="Send a room message">
    <div className="composer-meta"><label>Send to <select value={to} onChange={e=>setTo(e.target.value)}><option value="">Everyone</option>{members.map(m=><option value={m.principal_id} key={m.principal_id}>{m.display_name}</option>)}</select></label><span>Enter to send · Shift Enter for a new line</span></div>
    <div className="composer-input"><textarea aria-label="Message" placeholder="Add direction, context, or a question…" value={body} rows={2} onChange={e=>setBody(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();void submit()}}}/><button disabled={!body.trim()||busy} aria-label="Send message"><ArrowUp size={18}/></button></div>
    {error&&<p className="form-error" role="alert">{error}</p>}
  </form>
}

function DecisionCard({decision,requester,canResolve,onResolve}:{decision:Decision;requester?:Member;canResolve:boolean;onResolve:(r:'approve'|'reject',note:string)=>Promise<void>}){
  const [note,setNote]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[open,setOpen]=useState(false);
  const act=async(result:'approve'|'reject')=>{if(busy)return;setBusy(true);setError('');try{await onResolve(result,note)}catch(x){setError((x as Error).message);setBusy(false)}};
  return <article className="decision-card" data-testid="decision-card">
    <div className="decision-kicker"><ShieldAlert size={15}/><span>Human authority needed</span><time dateTime={decision.requested_at}>{formatTime(decision.requested_at)}</time></div>
    <h3>{decision.question}</h3>
    <p className="decision-by">Asked by <strong>{requester?.display_name??'Agent'}</strong>{decision.rationale&&<> · {decision.rationale}</>}</p>
    <button className="proposal-toggle" onClick={()=>setOpen(!open)} aria-expanded={open}>Proposed action <ChevronDown size={14}/></button>
    {open&&<pre>{JSON.stringify(decision.proposed_action,null,2)}</pre>}
    {canResolve?<><label className="instruction"><span>Optional instruction</span><textarea value={note} onChange={e=>setNote(e.target.value)} placeholder="Add a condition or next step" rows={2}/></label><div className="decision-actions"><button className="reject" disabled={busy} onClick={()=>void act('reject')}><X size={15}/>Reject</button><button className="approve" disabled={busy} onClick={()=>void act('approve')}><Check size={15}/>Approve</button></div></>:<p className="manager-note">A room manager can resolve this decision.</p>}
    {error&&<p className="form-error" role="alert">{error}</p>}
  </article>
}

function TaskRow({task,owner,canManage,onUpdate}:{task:Task;owner?:Member;canManage:boolean;onUpdate:(status:TaskStatus)=>Promise<void>}){
  const [busy,setBusy]=useState(false);
  const update=async(status:TaskStatus)=>{setBusy(true);try{await onUpdate(status)}finally{setBusy(false)}};
  return <li className={`task-row ${task.status}`} data-testid="task-row">
    <button className="task-state" aria-label={`${task.title}: ${labels[task.status]}`} disabled={!canManage||!transitions[task.status].length||busy} onClick={()=>{const next=transitions[task.status][0];if(next)void update(next)}}><span>{task.status==='completed'?<Check size={13}/>:task.status==='blocked'?<X size={12}/>:task.status==='awaiting_decision'?<Clock3 size={12}/>:null}</span></button>
    <div><strong>{task.title}</strong><small>{owner?.display_name??'Unassigned'} · {labels[task.status]}</small></div>
    {canManage&&transitions[task.status].length>1&&<select aria-label={`Change status for ${task.title}`} disabled={busy} value="" onChange={e=>void update(e.target.value as TaskStatus)}><option value="">•••</option>{transitions[task.status].map(s=><option value={s} key={s}>{labels[s]}</option>)}</select>}
  </li>
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
  // Every number in the mobile trigger is counted from state already known to be true.
  const openWork=snapshot.tasks.filter(t=>!['completed','cancelled'].includes(t.status));
  const blocked=openWork.filter(t=>t.status==='blocked');
  const working=agents.filter(a=>a.agent_presence==='connected'&&a.agent_runtime_status==='working');
  const attention=pending.length+blocked.length;

  return <main className="room-app">
    <header className="room-header"><div className="brand-mark">M</div><div className="room-title"><span>{snapshot.room.project_name}</span><h1>{snapshot.room.name}</h1></div><div className="objective"><span>Objective</span><p>{snapshot.room.objective}</p></div><button className="briefing-toggle" onClick={()=>setBriefingOpen(!briefingOpen)} aria-expanded={briefingOpen}>Briefing <ChevronDown size={14}/></button><Connection state={connection}/></header>
    {briefingOpen&&<section className="briefing"><div><span>Normalized room briefing</span><h2>{snapshot.briefing.project_objective}</h2></div><dl><div><dt>Your role</dt><dd>{snapshot.briefing.joining_principal.role}</dd></div><div><dt>Your responsibility</dt><dd>{snapshot.briefing.joining_principal.responsibilities||'Contribute to the room objective'}</dd></div><div><dt>Active work</dt><dd>{snapshot.briefing.active_tasks.length} tasks · {snapshot.briefing.blockers.length} blocked</dd></div></dl></section>}
    {connection==='revoked'&&<div className="revoked-screen" role="alert"><ShieldAlert/><h2>Room access removed</h2><p>{error}</p></div>}
    <div className="worktable" aria-hidden={connection==='revoked'}>
      <RoomContext workspace={workspace} snapshot={snapshot}/>
      <section className="conversation" aria-label="Live room conversation"><div className="section-heading"><div><span>Room conversation</span><strong>Shared, visible, durable</strong></div><span className="sequence">SEQ {snapshot.snapshot_seq}</span></div><Transcript messages={snapshot.messages} members={snapshot.members} lastEvent={lastEvent}/><Composer members={snapshot.members.filter(m=>m.principal_id!==identity.principalId)} onSend={(body,to)=>mutate(()=>api.sendMessage(body,to))}/></section>
      <aside className="supervision" aria-label="Live team and human oversight" data-open={oversightOpen}>
        <div className="sheet-bar">
          <span>Team &amp; work</span>
          <button ref={oversightClose} onClick={closeOversight} aria-label="Close team and work"><X size={16}/></button>
        </div>
        <div className="supervision-scroll">
          {pending.length>0&&<section className="decisions"><div className="section-label"><span>Needs attention</span><b>{pending.length}</b></div>{pending.map(d=><DecisionCard key={d.id} decision={d} requester={snapshot.members.find(m=>m.principal_id===d.requested_by_principal_id)} canResolve={managers} onResolve={(r,n)=>mutate(()=>api.resolveDecision(d,r,n))}/>)}</section>}
          <Participants members={snapshot.members} currentId={identity.principalId} tasks={snapshot.tasks} decisions={pending}/>
          <section className="tasks"><div className="section-label"><span>Shared work</span><b>{snapshot.tasks.filter(t=>!['completed','cancelled'].includes(t.status)).length}</b></div><ul>{snapshot.tasks.map(t=><TaskRow key={t.id} task={t} owner={snapshot.members.find(m=>m.principal_id===t.assignee_principal_id)} canManage={managers||t.assignee_principal_id===identity.principalId} onUpdate={s=>mutate(()=>api.updateTask(t.id,s,t.version))}/>)}</ul>{!snapshot.tasks.length&&<p className="small-empty">No tasks yet. Add the first concrete piece of work.</p>}<TaskCreator agents={agents} onCreate={x=>mutate(()=>api.createTask(x))}/></section>
          <details className="activity"><summary className="section-label"><span>Room activity</span></summary><ol>{recent.filter(e=>e.event_type!=='message.sent').slice(-5).reverse().map(e=><li key={e.room_seq}><span className={`event-dot ${e.actor_kind}`}/><p><strong>{e.actor_display_name}</strong> {activityText(e)}</p><time>{formatTime(e.created_at)}</time></li>)}</ol></details>
        </div>
      </aside>
      {oversightOpen&&<button className="sheet-scrim" aria-label="Close team and work" onClick={closeOversight}/>}
    </div>
    <button ref={oversightTrigger} className="oversight-trigger" onClick={()=>setOversightOpen(true)} aria-expanded={oversightOpen}>
      <span className="trigger-team">{agents.length} {agents.length===1?'agent':'agents'}{working.length?` · ${working.length} working`:''}</span>
      {attention>0&&<span className="trigger-attention">{attention} needs you</span>}
    </button>
    <div className="sr-live" aria-live="polite">{lastEvent&&`${lastEvent.actor_display_name} ${activityText(lastEvent)}`}</div>
  </main>;
}

export default RoomApp;
