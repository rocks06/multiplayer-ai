import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ArrowRight,Check,ChevronRight,Copy,Plus,RefreshCw} from 'lucide-react';
import {ApiError,addRoomMember,addWorkspaceAgent,createEnrollmentCode,createProject,createRoom,createWorkspace,setProjectObjective,
  currentIdentity,listWorkspaceAgents,listWorkspaceRooms,type SignedInIdentity,type WorkspaceAgent,type WorkspaceRoom} from './api';
import {rememberIntent} from './SignIn';

/**
 * Bringing your agents into one shared workspace.
 *
 * The steps are named for what the person gets, not for what the system stores, and each one
 * asks for the least it can. Nothing here invents progress: which step you are on is derived
 * from what the workspace actually contains, so closing the tab and coming back lands you where
 * you left off, and an agent counts as connected only when the Gateway says it has appeared.
 */

type Step='workspace'|'agents'|'room'|'connect'|'objective'|'ready';
export const UNSET_OBJECTIVE='No objective has been set yet.';

interface Workspace{companyId:string;name:string}

/**
 * Where to pick someone up, decided by what the workspace actually contains rather than by a
 * counter we kept. Agents that exist but have never arrived are unfinished business, so that is
 * where a returning person lands — not one step past it.
 *
 * This chooses the starting point only. Moving on from a step is something the person does.
 */
export function resumeAt(workspace:Workspace|null,agents:WorkspaceAgent[],rooms:WorkspaceRoom[]):Step{
  if(!workspace)return 'workspace';
  if(!agents.length)return 'agents';
  if(!rooms.length)return 'room';
  if(rooms[0]?.objective===UNSET_OBJECTIVE){
    if(agents.some(agent=>!connectionOf(agent).arrived))return 'connect';
    return 'objective';
  }
  return 'ready';
}

/**
 * How an agent is doing, in words that describe the outcome rather than the mechanism.
 *
 * An agent joins a room, so it cannot appear at all until there is one. Saying "waiting for it
 * to appear" before then would suggest something is imminent that nothing can deliver, so an
 * enrolled agent with nowhere to go is described as set up and waiting on the room instead.
 *
 * `arrived` means the Gateway has actually seen it. `ready` means the person has finished their
 * part — the code has been handed over — which is as far as this screen can take them.
 */
export function connectionOf(agent:WorkspaceAgent):{
  label:string;tone:'live'|'wait'|'idle'|'gone';arrived:boolean;ready:boolean}{
  const {enrolled,presence}=agent.connector;
  const roomed=Boolean(agent.rooms?.length);
  /* Where it is connected, not just that it is. This list spans the workspace while a room shows
     only its own members, so a bare "Connected" beside a room reporting the agent never appeared
     is the product contradicting itself. Naming the room makes both answers true at once. */
  const where=agent.connector.room_name?` · ${agent.connector.room_name}`:'';
  if(presence==='connected')return {label:`Connected${where}`,tone:'live',arrived:true,ready:true};
  if(presence==='stale')return {label:'Connected earlier, quiet just now',tone:'wait',arrived:true,ready:true};
  if(presence==='offline')return {label:'Connected earlier, not running now',tone:'gone',arrived:true,ready:true};
  if(presence==='revoked')return {label:'Access removed',tone:'gone',arrived:false,ready:false};
  if(enrolled&&!roomed)return {label:'Set up — it joins once there is a room',tone:'idle',arrived:false,ready:true};
  if(enrolled)return {label:'Waiting for it to appear',tone:'wait',arrived:false,ready:true};
  return {label:'Not connected yet',tone:'idle',arrived:false,ready:false};
}

function problemText(problem:unknown):string{
  const error=problem instanceof ApiError?problem:null;
  if(error?.status===401)return 'Your sign-in expired. Sign in again to continue.';
  if(error?.code==='forbidden')return 'This workspace is not yours to change.';
  const message=(problem as Error)?.message;
  return message||'Something went wrong. Try again.';
}

function useSubmit(){
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const run=async(work:()=>Promise<unknown>)=>{
    if(busy)return;
    setBusy(true);setProblem('');
    try{await work()}catch(failure){setProblem(problemText(failure))}
    finally{setBusy(false)}
  };
  return {busy,problem,setProblem,run};
}

function Shell({step,children}:{step:Step;children:React.ReactNode}){
  const steps:Array<{key:Step;label:string}>=[
    {key:'workspace',label:'Workspace'},{key:'agents',label:'Agents'},{key:'room',label:'Room'},
    {key:'connect',label:'Connect'},{key:'objective',label:'First work'},{key:'ready',label:'Ready'}];
  const at=steps.findIndex(s=>s.key===step);
  return <main className="welcome">
    <div className="welcome-panel">
      <div className="brand-mark" aria-hidden="true">M</div>
      <ol className="welcome-steps" aria-label="Setup progress">
        {steps.map((s,index)=>
          <li key={s.key} data-state={index<at?'done':index===at?'now':'todo'}>
            <span aria-hidden="true">{index<at?<Check size={11}/>:index+1}</span>
            {s.label}
          </li>)}
      </ol>
      {children}
    </div>
  </main>;
}

function NameWorkspace({onCreated}:{onCreated:(workspace:Workspace)=>void}){
  const [name,setName]=useState('');
  const {busy,problem,run}=useSubmit();
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus()},[]);
  return <>
    <h1>Bring your agents into one shared workspace</h1>
    <p className="welcome-lead">
      A workspace is the place your agents work together, where you can see what they are doing
      and step in when it matters. Give it a name to start.
    </p>
    <form onSubmit={(event:FormEvent)=>{event.preventDefault();if(name.trim())void run(async()=>{
      const created=await createWorkspace(name.trim());
      onCreated({companyId:created.company_id,name:created.name});
    })}}>
      <label htmlFor="workspace-name">Workspace name</label>
      <input id="workspace-name" ref={field} value={name} autoComplete="organization" placeholder="Acme"
        onChange={event=>setName(event.target.value)} maxLength={100}/>
      <button disabled={busy||!name.trim()}>{busy?'Creating…':'Continue'}<ArrowRight size={15}/></button>
      {problem&&<p className="auth-error" role="alert">{problem}</p>}
    </form>
  </>;
}

/**
 * Connecting an agent that runs somewhere else.
 *
 * On the Mac the agent runs on, Multiplayer AI connects it directly — you are signed in there,
 * so there is nobody to carry anything between. A code exists for the case where that is not
 * true: a machine you are not signed in on. That is what this screen is for, and it is the
 * exception rather than the way in. Nothing here reports a connection the Gateway has not seen.
 */
export function ConnectAgent({companyId,roomId,roomName,agent,onChanged}:{
  companyId:string;roomId:string;roomName?:string;agent:WorkspaceAgent;onChanged:()=>void}){
  const [code,setCode]=useState<{value:string;expiresAt:string}|null>(null);
  const [expired,setExpired]=useState(false);
  const [copied,setCopied]=useState(false);
  const [helpOpen,setHelpOpen]=useState(false);
  const {busy,problem,run}=useSubmit();
  const connection=connectionOf(agent);

  // A code is short-lived; when it lapses the screen says so rather than leaving a dead code up.
  useEffect(()=>{
    if(!code)return;
    setExpired(false);
    const remaining=Date.parse(code.expiresAt)-Date.now();
    if(remaining<=0){setExpired(true);return}
    const timer=setTimeout(()=>setExpired(true),remaining);
    return()=>clearTimeout(timer);
  },[code]);

  // Once connected the code has done its job and should not linger on screen.
  useEffect(()=>{if(connection.ready)setCode(null)},[connection.ready]);

  const issue=()=>run(async()=>{
    const issued=await createEnrollmentCode(companyId,agent.principal_id,`${agent.display_name} runtime`,roomId);
    setCode({value:issued.enrollment_code,expiresAt:issued.expires_at});
    setCopied(false);
    onChanged();
  });

  return <div className="connect">
    <p className={`connect-state ${connection.tone}`}><span className="state-dot" aria-hidden="true"/>{connection.label}</p>

    {!connection.ready&&!code&&
      <button type="button" className="connect-start" disabled={busy} onClick={()=>void issue()}>
        {busy?'Preparing…':'Connect this agent'}</button>}

    {!connection.ready&&code&&<div className="code-block">
      {expired
        ? <>
            <p className="code-note">That code expired. Codes are short-lived on purpose.</p>
            <button type="button" className="connect-start" disabled={busy} onClick={()=>void issue()}>
              <RefreshCw size={13}/>{busy?'Preparing…':'Get a new code'}</button>
          </>
        : <>
            <p className="code-note">
              Enter this in Multiplayer AI on the machine where {agent.display_name} runs.
              {roomName&&<> It connects {agent.display_name} to <strong>{roomName}</strong>.</>}
            </p>
            <div className="code-value">
              <code>{code.value}</code>
              <button type="button" aria-label="Copy code" onClick={()=>{
                void navigator.clipboard?.writeText(code.value).then(()=>setCopied(true)).catch(()=>{});
              }}>{copied?<Check size={13}/>:<Copy size={13}/>}</button>
            </div>
            <p className="code-note quiet">
              It can be used once, and expires {new Date(code.expiresAt).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})}.
              {' '}This screen updates on its own when {agent.display_name} arrives.
            </p>
          </>}
    </div>}

    {problem&&<p className="auth-error" role="alert">{problem}</p>}

    {!connection.ready&&<details className="connect-help" open={helpOpen}
      onToggle={event=>setHelpOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>When do I need a code?</summary>
      <p>
        Only for a machine you are not signed in on. On the Mac where the agent runs, install
        Multiplayer AI, sign in, and it connects the agent directly — no code involved. The code
        above is for the other case: hand it to Multiplayer AI on that machine and it will join
        the same agent. Either way, the agent’s own runtime must already be installed there.
      </p>
    </details>}
  </div>;
}

function AddAgent({onAdd,count}:{onAdd:(name:string)=>Promise<unknown>;count:number}){
  const [open,setOpen]=useState(count===0);
  const [name,setName]=useState('');
  const {busy,problem,run}=useSubmit();
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{if(open)field.current?.focus()},[open]);

  if(!open)return <button type="button" className="add-agent" onClick={()=>setOpen(true)}>
    <Plus size={14}/>Connect another agent</button>;

  return <form className="agent-form" onSubmit={(event:FormEvent)=>{
    event.preventDefault();
    if(name.trim())void run(async()=>{await onAdd(name.trim());setName('');setOpen(false)});
  }}>
    <label htmlFor="agent-name">Agent name</label>
    <input id="agent-name" ref={field} value={name} placeholder="Research agent" maxLength={100}
      onChange={event=>setName(event.target.value)}/>
    <small className="field-hint">What you want to call it here. Its own setup does not change.</small>
    <div className="agent-form-actions">
      {count>0&&<button type="button" onClick={()=>{setOpen(false);setName('')}} disabled={busy}>Cancel</button>}
      <button disabled={busy||!name.trim()}>{busy?'Adding…':'Add agent'}</button>
    </div>
    {problem&&<p className="auth-error" role="alert">{problem}</p>}
  </form>;
}

function Agents({agents,onAdd,onDone}:{
  companyId:string;agents:WorkspaceAgent[];onAdd:(name:string)=>Promise<unknown>;onRefresh:()=>void;onDone:()=>void}){
  return <>
    <h1>{agents.length?'Your agents':'Connect your first agent'}</h1>
    <p className="welcome-lead">
      {agents.length
        ? 'Agents work together in a room, so most workspaces want at least two. You will make their room next, then connect each one from the Mac it runs on.'
        : 'Multiplayer AI does not run agents for you. Name an agent you already run, and it gets an identity here that you connect from the Mac it runs on.'}
    </p>

    {agents.length>0&&<ul className="agent-list">
      {agents.map(agent=><li key={agent.principal_id}>
        <div className="agent-head">
          <span className="identity-mark agent" aria-hidden="true">{agent.display_name.slice(0,1).toUpperCase()}</span>
          <strong>{agent.display_name}</strong>
        </div>
        <p className="connect-state idle"><span className="state-dot" aria-hidden="true"/>Not connected yet</p>
      </li>)}
    </ul>}

    <AddAgent onAdd={onAdd} count={agents.length}/>

    {agents.length>0&&<div className="welcome-forward">
      <button type="button" className="primary" onClick={onDone}>
        Next: create a room<ArrowRight size={15}/></button>
    </div>}
  </>;
}

function CreateFirstRoom({companyId,agents,onCreated}:{
  companyId:string;agents:WorkspaceAgent[];onCreated:(room:WorkspaceRoom)=>Promise<void>}){
  const [name,setName]=useState('');
  const {busy,problem,run}=useSubmit();
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus()},[]);

  const submit=(event:FormEvent)=>{
    event.preventDefault();
    if(!name.trim())return;
    void run(async()=>{
      const project=await createProject(companyId,name.trim(),UNSET_OBJECTIVE);
      const room=await createRoom(companyId,project.id,name.trim());
      for(const agent of agents)await addRoomMember(companyId,room.id,agent.principal_id,'');
      await onCreated({room_id:room.id,name:room.name,project_id:project.id,project_name:project.name,objective:UNSET_OBJECTIVE});
    });
  };

  return <>
    <h1>Create their room</h1>
    <p className="welcome-lead">
      {agents.map(a=>a.display_name).join(' and ')} need a room before they can join.
      Name it now; you will connect them before setting the first objective.
    </p>
    <form onSubmit={submit}>
      <label htmlFor="work-name">Room name</label>
      <input id="work-name" ref={field} value={name} placeholder="Developer API" maxLength={100}
        onChange={event=>setName(event.target.value)}/>
      <button disabled={busy||!name.trim()}>{busy?'Setting up…':'Create the room'}<ArrowRight size={15}/></button>
      {problem&&<p className="auth-error" role="alert">{problem}</p>}
    </form>
  </>;
}

function ConnectAgents({companyId,room,agents,onRefresh,onDone}:{
  companyId:string;room:WorkspaceRoom;agents:WorkspaceAgent[];onRefresh:()=>void;onDone:()=>void}){
  const waiting=agents.filter(agent=>!connectionOf(agent).arrived);
  return <>
    <h1>Connect your agents</h1>
    <p className="welcome-lead">Their room is ready. Open Multiplayer AI on the Mac each agent runs on. The first objective unlocks after every agent has appeared.</p>
    <ul className="agent-list">{agents.map(agent=><li key={agent.principal_id}>
      <div className="agent-head"><span className="identity-mark agent" aria-hidden="true">{agent.display_name.slice(0,1).toUpperCase()}</span><strong>{agent.display_name}</strong></div>
      <ConnectAgent companyId={companyId} roomId={room.room_id} roomName={room.name} agent={agent} onChanged={onRefresh}/>
    </li>)}</ul>
    <div className="welcome-forward"><button type="button" className="primary" disabled={waiting.length>0} onClick={onDone}>Next: set the first objective<ArrowRight size={15}/></button>
      {waiting.length>0&&<p className="welcome-note">This unlocks after {waiting.map(agent=>agent.display_name).join(' and ')} {waiting.length===1?'connects':'connect'}.</p>}
    </div>
  </>;
}

function FirstObjective({companyId,room,onDone}:{companyId:string;room:WorkspaceRoom;onDone:()=>void}){
  const [objective,setObjective]=useState('');
  const {busy,problem,run}=useSubmit();
  const field=useRef<HTMLTextAreaElement>(null);
  useEffect(()=>{field.current?.focus()},[]);
  return <>
    <h1>Set the first objective</h1>
    <p className="welcome-lead">Tell everyone in {room.name} what they should achieve first.</p>
    <form onSubmit={(event:FormEvent)=>{event.preventDefault();if(objective.trim())void run(async()=>{
      await setProjectObjective(companyId,room.project_id,objective.trim(),UNSET_OBJECTIVE);onDone();
    })}}>
      <label htmlFor="work-objective">What are they trying to achieve?</label>
      <textarea id="work-objective" ref={field} value={objective} rows={3} placeholder="Launch the public developer API" onChange={event=>setObjective(event.target.value)}/>
      <button disabled={busy||!objective.trim()}>{busy?'Saving…':'Enter the room'}<ArrowRight size={15}/></button>
      {problem&&<p className="auth-error" role="alert">{problem}</p>}
    </form>
  </>;
}

function Ready({workspace,rooms,agents,onEnter}:{
  workspace:Workspace;rooms:WorkspaceRoom[];agents:WorkspaceAgent[];onEnter:(room:WorkspaceRoom)=>void}){
  const waiting=agents.filter(agent=>!connectionOf(agent).ready);
  return <>
    <h1>{workspace.name} is ready</h1>
    <p className="welcome-lead">
      {rooms.length===1?'Your room is set up.':'Your rooms are set up.'} Everything that happens
      in one is shared, visible, and kept.
    </p>
    <ul className="room-list">
      {rooms.map(room=><li key={room.room_id}>
        <button type="button" onClick={()=>onEnter(room)}>
          {/* Setting up asks for one name, so the project line earns its place only when it
              actually says something the room name does not. */}
          <span><strong>{room.name}</strong>{room.project_name!==room.name&&<small>{room.project_name}</small>}</span>
          <ChevronRight size={16}/>
        </button>
      </li>)}
    </ul>
    {waiting.length>0&&<p className="welcome-note">
      {waiting.map(a=>a.display_name).join(' and ')} {waiting.length===1?'is':'are'} not connected yet.
      {' '}You can bring {waiting.length===1?'it':'them'} in from the room whenever you are at
      {' '}{waiting.length===1?'its':'their'} machine.
    </p>}
  </>;
}

export default function Welcome({navigate}:{navigate:(to:string)=>void}){
  const [identity,setIdentity]=useState<SignedInIdentity|null>(null);
  const [workspace,setWorkspace]=useState<Workspace|null>(null);
  const [agents,setAgents]=useState<WorkspaceAgent[]>([]);
  const [rooms,setRooms]=useState<WorkspaceRoom[]>([]);
  const [state,setState]=useState<'loading'|'ready'|'signed_out'>('loading');
  /* Adopted once from the workspace when it loads, and after that changed only by the person.
     Adding an agent must not shunt them past connecting it. */
  const [here,setHere]=useState<Step|null>(null);

  const load=useCallback(async()=>{
    const me=await currentIdentity();
    if(!me){setState('signed_out');return}
    setIdentity(me);
    const company=me.companies[0];
    if(!company){setWorkspace(null);setAgents([]);setRooms([]);setState('ready');return}
    setWorkspace({companyId:company.company_id,name:company.company_name});
    const [foundAgents,foundRooms]=await Promise.all([
      listWorkspaceAgents(company.company_id).catch(()=>[]),
      listWorkspaceRooms(company.company_id).catch(()=>[]),
    ]);
    setAgents(foundAgents);setRooms(foundRooms);setState('ready');
  },[]);

  useEffect(()=>{void load()},[load]);
  useEffect(()=>{
    if(state==='ready'&&here===null)setHere(resumeAt(workspace,agents,rooms));
  },[state,here,workspace,agents,rooms]);
  useEffect(()=>{
    if(state==='signed_out'){rememberIntent('/welcome');navigate('/signin')}
  },[state,navigate]);

  // While an agent is expected but has not appeared, ask the workspace rather than assume.
  const awaiting=agents.some(agent=>agent.rooms?.length&&!connectionOf(agent).arrived);
  useEffect(()=>{
    if(!awaiting||!workspace)return;
    const timer=setInterval(()=>{void listWorkspaceAgents(workspace.companyId).then(setAgents).catch(()=>{})},4000);
    return()=>clearInterval(timer);
  },[awaiting,workspace]);

  if(state!=='ready')return <main className="welcome"><div className="welcome-panel">
    <div className="brand-mark" aria-hidden="true">M</div>
    <p className="auth-quiet" role="status">Loading your workspace…</p></div></main>;

  const step:Step=here??resumeAt(workspace,agents,rooms);
  const enter=(room:WorkspaceRoom)=>navigate(`/rooms/${workspace!.companyId}/${room.room_id}`);

  return <Shell step={step}>
    {step==='workspace'&&<NameWorkspace onCreated={created=>{setWorkspace(created);setHere('agents');void load()}}/>}
    {step==='agents'&&workspace&&
      <Agents companyId={workspace.companyId} agents={agents}
        onAdd={async name=>{await addWorkspaceAgent(workspace.companyId,name);await load()}}
        onRefresh={()=>{void load()}}
        onDone={()=>setHere('room')}/>}
    {step==='room'&&workspace&&<CreateFirstRoom companyId={workspace.companyId} agents={agents}
      onCreated={async room=>{setRooms([room]);await load();setHere('connect')}}/>}
    {step==='connect'&&workspace&&rooms[0]&&<ConnectAgents companyId={workspace.companyId} room={rooms[0]} agents={agents}
      onRefresh={()=>{void load()}} onDone={()=>setHere('objective')}/>}
    {step==='objective'&&workspace&&rooms[0]&&<FirstObjective companyId={workspace.companyId} room={rooms[0]}
      onDone={()=>{void load();enter(rooms[0]!)}}/>}
    {step==='ready'&&workspace&&<Ready workspace={workspace} rooms={rooms} agents={agents} onEnter={enter}/>}
    {step==='room'&&<button type="button" className="welcome-back" onClick={()=>setHere('agents')}>Back to agents</button>}
    {identity&&<p className="welcome-who">Signed in as {identity.user.display_name}</p>}
  </Shell>;
}
