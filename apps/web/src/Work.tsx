import {useEffect,useRef,useState} from 'react';
import {Check,ChevronDown,Plus,ShieldAlert,X} from 'lucide-react';
import {ApiError} from './api';
import {useConfirm} from './Confirm';
import type {CompanyAgent,Member,Task,TaskStatus} from './types';

/**
 * Shared work exists to make the agents' work understandable and controllable, not to be a
 * project tracker. Every row answers what the work is, who owns it, and what is holding it up;
 * everything that changes state is deliberate, named for what it does, and opened on demand so
 * supervision never occupies more of the room than the conversation it supports.
 */

export const STATUS_LABELS:Record<TaskStatus,string>={open:'Open',in_progress:'In progress',blocked:'Blocked',awaiting_decision:'Awaiting decision',completed:'Completed',cancelled:'Cancelled'};
const TERMINAL:TaskStatus[]=['completed','cancelled'];
const isOpen=(task:Task)=>!TERMINAL.includes(task.status);

/** The blockers the engine actually recorded, never inferred from status or ordering. */
export function blockersOf(task:Task){return (task.blocked_by??[]).filter(b=>!TERMINAL.includes(b.status))}

export interface WorkActions{
  setStatus(task:Task,status:TaskStatus):Promise<unknown>;
  reassign(task:Task,assigneePrincipalId:string|null):Promise<unknown>;
  addDependency(task:Task,dependsOnTaskId:string):Promise<unknown>;
  removeDependency(task:Task,dependsOnTaskId:string):Promise<unknown>;
  override(task:Task,reason:string):Promise<unknown>;
  pause(agent:CompanyAgent):Promise<unknown>;
  resume(agent:CompanyAgent):Promise<unknown>;
}

/** What the server refused, said back in terms of the work rather than the request. */
function problemText(problem:unknown):string{
  const error=problem instanceof ApiError?problem:null;
  if(error?.code==='task_dependencies_incomplete'){
    const blocking=(error.details?.blocked_by as {title:string}[]|undefined)??[];
    const names=blocking.map(b=>`“${b.title}”`).join(' and ');
    return names?`Not started — this work depends on ${names}, which is not finished.`:'Not started — this work depends on unfinished work.';
  }
  if(error?.code==='version_conflict')return 'This work changed while you were looking at it. It has been refreshed — check it and try again.';
  if(error?.code==='permission_denied')return 'You do not have authority to change this work.';
  if(error?.code==='invalid_task_transition')return 'That change is not possible from the current state.';
  if(error?.code==='invalid_task_dependency')return 'A task cannot depend on itself.';
  const message=(problem as Error)?.message;
  return message?`Not changed — ${message}`:'Not changed.';
}

/** One in-flight change at a time per surface, with the refusal kept where the action was. */
function useAction(){
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const run=async(work:()=>Promise<unknown>,after?:()=>void)=>{
    if(busy)return false;
    setBusy(true);setProblem('');
    try{await work();after?.();return true}
    catch(failure){setProblem(problemText(failure));return false}
    finally{setBusy(false)}
  };
  return {busy,problem,setProblem,run};
}

function ownerName(members:Member[],id:string|null){return members.find(m=>m.principal_id===id)?.display_name??'Unassigned'}

/**
 * Overriding a dependency is not "continue anyway": it deliberately sets aside a constraint the
 * room recorded, and it is written into the room under the manager's name. The control says
 * both, names the unfinished work being bypassed, and will not proceed without a reason.
 */
function DependencyOverride({task,members,onOverride}:{task:Task;members:Member[];onOverride:(reason:string)=>Promise<unknown>}){
  const [open,setOpen]=useState(false);
  const [reason,setReason]=useState('');
  const {busy,problem,run}=useAction();
  const blockers=blockersOf(task);
  const field=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{if(open)field.current?.focus()},[open]);
  if(!blockers.length)return null;

  if(!open)return <button type="button" className="override-open" onClick={()=>setOpen(true)}>
    <ShieldAlert size={13}/>Override this constraint…
  </button>;

  return <section className="override" aria-label="Override dependency">
    <p className="override-head"><ShieldAlert size={14}/><strong>You are bypassing a work constraint</strong></p>
    <p className="override-body">
      <strong>{task.title}</strong> was recorded as depending on work that is not finished:
    </p>
    <ul className="override-list">
      {blockers.map(b=><li key={b.task_id}>{b.title} — {ownerName(members,b.assignee_principal_id)} · {STATUS_LABELS[b.status]}</li>)}
    </ul>
    <p className="override-body">
      Overriding lets {ownerName(members,task.assignee_principal_id)} start before that work is done.
      It is recorded in the room as your decision, with the reason you give.
    </p>
    <label className="override-reason">
      <span>Why are you overriding this?</span>
      <textarea ref={field} rows={2} value={reason} maxLength={500} disabled={busy}
        placeholder="State what makes it safe to start now" onChange={e=>setReason(e.target.value)}/>
    </label>
    {problem&&<p className="form-error" role="alert">{problem}</p>}
    <div className="override-actions">
      <button type="button" onClick={()=>{setOpen(false);setReason('')}} disabled={busy}>Keep the constraint</button>
      <button type="button" className="override-commit" disabled={busy||!reason.trim()}
        onClick={()=>void run(()=>onOverride(reason.trim()),()=>{setOpen(false);setReason('')})}>
        {busy?'Recording…':'Override and record'}
      </button>
    </div>
  </section>;
}

function DependencyEditor({task,tasks,members,actions}:{task:Task;tasks:Task[];members:Member[];actions:WorkActions}){
  const {busy,problem,run}=useAction();
  const [adding,setAdding]=useState('');
  const blockers=task.blocked_by??[];
  const known=new Set(blockers.map(b=>b.task_id));
  const candidates=tasks.filter(t=>t.id!==task.id&&!known.has(t.id)&&isOpen(t));

  return <div className="dep-editor">
    <span className="field-label">Waiting on</span>
    {blockers.length
      ? <ul className="dep-list">{blockers.map(b=>
          <li key={b.task_id}>
            <span>{b.title} — {ownerName(members,b.assignee_principal_id)} · {STATUS_LABELS[b.status]}</span>
            <button type="button" disabled={busy} aria-label={`Remove dependency on ${b.title}`}
              onClick={()=>void run(()=>actions.removeDependency(task,b.task_id))}><X size={12}/></button>
          </li>)}</ul>
      : <p className="dep-none">Nothing. This work can proceed on its own.</p>}
    {candidates.length>0&&<div className="dep-add">
      <select aria-label={`Add a dependency for ${task.title}`} value={adding} disabled={busy}
        onChange={e=>setAdding(e.target.value)}>
        <option value="">Add work this depends on…</option>
        {candidates.map(t=><option value={t.id} key={t.id}>{t.title}</option>)}
      </select>
      <button type="button" disabled={busy||!adding}
        onClick={()=>void run(()=>actions.addDependency(task,adding),()=>setAdding(''))}><Plus size={13}/>Add</button>
    </div>}
    {problem&&<p className="form-error" role="alert">{problem}</p>}
  </div>;
}

/** Cancelling ends a piece of work for good, so it asks once and says what it means. */
function CancelWork({task,onCancel}:{task:Task;onCancel:()=>Promise<unknown>}){
  const [confirming,setConfirming]=useState(false);
  const {busy,problem,run}=useAction();
  if(!confirming)return <button type="button" className="danger-quiet" onClick={()=>setConfirming(true)}>Cancel work</button>;
  return <div className="confirm">
    <p>Cancel <strong>{task.title}</strong>? It stops for good and cannot be reopened.</p>
    {problem&&<p className="form-error" role="alert">{problem}</p>}
    <div className="confirm-actions">
      <button type="button" onClick={()=>setConfirming(false)} disabled={busy}>Keep it</button>
      <button type="button" className="danger" disabled={busy} onClick={()=>void run(onCancel)}>{busy?'Cancelling…':'Cancel work'}</button>
    </div>
  </div>;
}

/**
 * The panel offers only what this person actually holds authority for. A contributor may move
 * their own work; changing who owns it, what it depends on, or setting a constraint aside is a
 * manager's authority, so those controls are absent rather than present and refused.
 */
function TaskManage({task,tasks,members,agents,actions,canManage}:{task:Task;tasks:Task[];members:Member[];agents:Member[];actions:WorkActions;canManage:boolean}){
  const {busy,problem,setProblem,run}=useAction();
  const blockers=blockersOf(task);
  const canStart=task.status==='open'||task.status==='blocked';

  return <div className="task-manage">
    {canManage&&<label className="field">
      <span className="field-label">Owner</span>
      <select value={task.assignee_principal_id??''} disabled={busy}
        aria-label={`Owner of ${task.title}`}
        onChange={e=>void run(()=>actions.reassign(task,e.target.value||null))}>
        <option value="">Unassigned</option>
        {agents.map(a=><option value={a.principal_id} key={a.principal_id}>{a.display_name}</option>)}
      </select>
    </label>}

    {canManage&&<DependencyEditor task={task} tasks={tasks} members={members} actions={actions}/>}

    <div className="task-verbs">
      {canStart&&<button type="button" disabled={busy} onClick={()=>void run(()=>actions.setStatus(task,'in_progress'))}>Start</button>}
      {task.status==='in_progress'&&<button type="button" disabled={busy} onClick={()=>void run(()=>actions.setStatus(task,'completed'))}>Mark complete</button>}
      <CancelWork task={task} onCancel={()=>actions.setStatus(task,'cancelled')}/>
    </div>
    {problem&&<p className="form-error" role="alert">{problem}</p>}
    {/* Offered only where a real constraint exists, and only after the guard has been met. */}
    {canManage&&blockers.length>0&&!task.dependency_override_at&&
      <DependencyOverride task={task} members={members}
        onOverride={reason=>actions.override(task,reason).then(()=>setProblem(''))}/>}
    {task.dependency_override_at&&<p className="override-noted"><ShieldAlert size={12}/>Dependencies overridden and recorded.</p>}
  </div>;
}

function TaskRow({task,tasks,members,agents,canManage,mine,actions}:{task:Task;tasks:Task[];members:Member[];agents:Member[];canManage:boolean;mine:boolean;actions:WorkActions}){
  const [open,setOpen]=useState(false);
  const blockers=blockersOf(task);
  const owner=ownerName(members,task.assignee_principal_id);
  /* What is holding this up, named — a modelled dependency, never a guess from status alone.
     Once a dependency has been overridden the work is no longer waiting on it, so the row goes
     back to reporting its status and the override is stated separately. */
  const held=blockers.length>0&&!task.dependency_override_at&&['open','blocked'].includes(task.status);
  // Naming a person only helps when it is someone else; otherwise name the work.
  const others=blockers.map(b=>b.assignee_principal_id).filter(id=>id&&id!==task.assignee_principal_id);
  const peers=[...new Set(others)].map(id=>ownerName(members,id));
  const waiting=held
    ? peers.length?`Waiting on ${peers.join(', ')}`:'Waiting on earlier work'
    : STATUS_LABELS[task.status];

  return <li className={`task-row ${task.status}`} data-testid="task-row">
    <div className="task-line">
      <span className={`task-mark ${task.status}`} aria-hidden="true">
        {task.status==='completed'?<Check size={12}/>:task.status==='cancelled'?<X size={11}/>:null}
      </span>
      <div className="task-text">
        <strong>{task.title}</strong>
        <small>{owner} · {waiting}</small>
      </div>
      {(canManage||mine)&&isOpen(task)&&
        <button type="button" className="task-open" aria-expanded={open} aria-label={`Manage ${task.title}`}
          onClick={()=>setOpen(v=>!v)}><ChevronDown size={14}/></button>}
    </div>
    {blockers.length>0&&<ul className="task-blockers">
      {blockers.map(b=><li key={b.task_id}>{b.title} — {ownerName(members,b.assignee_principal_id)} · {STATUS_LABELS[b.status]}</li>)}
      {task.dependency_override_at&&<li className="blocker-overridden"><ShieldAlert size={11}/>Overridden by a manager and recorded.</li>}
    </ul>}
    {/* Work that has ended offers nothing to change, even if its panel was open when it ended. */}
    {open&&(canManage||mine)&&isOpen(task)&&<TaskManage task={task} tasks={tasks} members={members} agents={agents} actions={actions} canManage={canManage}/>}
  </li>;
}

export function SharedWork({tasks,members,agents,canManage,currentId,actions,children}:{
  tasks:Task[];members:Member[];agents:Member[];canManage:boolean;currentId:string;actions:WorkActions;children?:React.ReactNode}){
  const live=tasks.filter(isOpen);
  return <section className="tasks" data-onboarding="shared-work">
    <div className="section-label"><span>Shared work</span><b>{live.length}</b></div>
    <ul>{tasks.map(task=>
      <TaskRow key={task.id} task={task} tasks={tasks} members={members} agents={agents}
        canManage={canManage} mine={task.assignee_principal_id===currentId} actions={actions}/>)}</ul>
    {!tasks.length&&<p className="small-empty">No work yet. Add the first concrete piece.</p>}
    {children}
  </section>;
}

/**
 * Supervising an agent is occasional, so it stays folded away until asked for.
 *
 * Pause is stated for what the engine can actually guarantee. It stops new work and voids
 * everything in flight — nothing the agent sends back will be accepted — but the process on its
 * own machine may still be finishing its current step, and finds out at its next contact. The
 * copy says that rather than pretending a remote process stopped on command.
 */
export function AgentControls({member,agent,canManage,actions,onMessage,onConnect,onDisconnect}:{
  member:Member;agent?:CompanyAgent;canManage:boolean;actions:WorkActions;onMessage:(principalId:string)=>void;onConnect?:(member:Member)=>void;onDisconnect?:(member:Member)=>Promise<void>}){
  const [open,setOpen]=useState(false);
  const [confirmingPause,setConfirmingPause]=useState(false);
  const {busy,problem,run}=useAction();
  const {confirm,dialog}=useConfirm();
  if(!canManage)return null;
  const paused=agent?.status==='paused';

  return <div className="agent-controls">
    <button type="button" className="agent-more" aria-expanded={open}
      aria-label={`Supervise ${member.display_name}`} onClick={()=>{setOpen(v=>!v);setConfirmingPause(false)}}>•••</button>
    {open&&<div className="agent-menu">
      <button type="button" onClick={()=>{onMessage(member.principal_id);setOpen(false)}}>Message {member.display_name}</button>
      {member.agent_presence==='never'&&onConnect&&<button type="button" onClick={()=>{onConnect(member);setOpen(false)}}>Connect {member.display_name}</button>}
        {onDisconnect&&<button type="button" className="danger" onClick={()=>{
          setOpen(false);
          confirm({
            title:`Disconnect ${member.display_name} from this room?`,
            detail:'It stops working here now and leaves this room. It keeps its identity and '
              +'credential, so it can be added back and connected again without a new code.',
            action:'Disconnect from room',
            run:()=>onDisconnect(member),
          });
        }}>Disconnect from room</button>}

      {!agent&&<p className="agent-note">This agent is not registered to the workspace, so it cannot be paused from here.</p>}

      {agent&&paused&&<button type="button" disabled={busy}
        onClick={()=>void run(()=>actions.resume(agent),()=>setOpen(false))}>
        {busy?'Resuming…':`Resume ${member.display_name}`}</button>}

      {agent&&!paused&&!confirmingPause&&
        <button type="button" onClick={()=>setConfirmingPause(true)}>Pause {member.display_name}</button>}

      {agent&&!paused&&confirmingPause&&<div className="confirm">
        <p>Pause <strong>{member.display_name}</strong>?</p>
        <p className="agent-note">
          New work stops now, and anything in flight is cancelled — nothing {member.display_name} sends
          back will be accepted. Its process on its own machine may still be finishing the step it
          started; it finds out the next time it contacts the room.
        </p>
        <div className="confirm-actions">
          <button type="button" onClick={()=>setConfirmingPause(false)} disabled={busy}>Keep working</button>
          <button type="button" className="danger" disabled={busy}
            onClick={()=>void run(()=>actions.pause(agent),()=>setOpen(false))}>{busy?'Pausing…':'Pause agent'}</button>
        </div>
      </div>}

      {paused&&<p className="agent-note">Paused. It will not take work until resumed. Resuming does not restart what was cancelled.</p>}
      {problem&&<p className="form-error" role="alert">{problem}</p>}
    </div>}
  </div>;
}
