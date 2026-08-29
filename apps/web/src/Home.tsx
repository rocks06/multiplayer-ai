import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ChevronRight,Plus} from 'lucide-react';
import {ApiError,addRoomMember,addWorkspaceAgent,createProject,createRoom,
  listWorkspaceAgents,listWorkspaceRooms,type WorkspaceAgent,type WorkspaceRoom} from './api';
import {connectionOf} from './Welcome';

/**
 * Home answers one question: where is my work?
 *
 * It is navigation and context, not the product. No counts anyone has to interpret, no charts,
 * nothing that needs explaining — the rooms you can open, the agents you have, and the two
 * things you might want to start. Everything shown comes from what the workspace actually
 * contains; nothing here is inferred.
 */
export function Home({workspace,onNavigate}:{
  workspace:{companyId:string;name:string};onNavigate:(to:string)=>void}){
  const [rooms,setRooms]=useState<WorkspaceRoom[]|null>(null);
  const [agents,setAgents]=useState<WorkspaceAgent[]>([]);
  const [creating,setCreating]=useState(false);
  const [addingAgent,setAddingAgent]=useState(false);

  const load=useCallback(async()=>{
    const [foundRooms,foundAgents]=await Promise.all([
      listWorkspaceRooms(workspace.companyId).catch(()=>[]),
      listWorkspaceAgents(workspace.companyId).catch(()=>[]),
    ]);
    setRooms(foundRooms);setAgents(foundAgents);
  },[workspace.companyId]);
  useEffect(()=>{void load()},[load]);

  if(rooms===null)return <main className="home"><p className="auth-quiet" role="status">Loading your workspace…</p></main>;

  return <main className="home">
    <header className="home-head">
      <h1>{workspace.name}</h1>
      <p className="home-lead">Your rooms, and the agents you have connected to them.</p>
    </header>

    <section className="home-section" aria-labelledby="home-rooms">
      <div className="home-section-head">
        <h2 id="home-rooms">Rooms</h2>
        {rooms.length>0&&!creating&&
          <button type="button" className="home-action" onClick={()=>setCreating(true)}><Plus size={13}/>Create room</button>}
      </div>

      {rooms.length===0&&!creating&&<div className="home-empty">
        <p>No rooms yet. A room is where your agents work together on one objective.</p>
        <button type="button" className="home-primary" onClick={()=>setCreating(true)}><Plus size={14}/>Create your first room</button>
      </div>}

      {creating&&<CreateRoom companyId={workspace.companyId} agents={agents}
        onCancel={()=>setCreating(false)}
        onCreated={room=>onNavigate(`/rooms/${workspace.companyId}/${room.room_id}`)}/>}

      {rooms.length>0&&<ul className="home-rooms">
        {rooms.map(room=>
          <li key={room.room_id}>
            <button type="button" onClick={()=>onNavigate(`/rooms/${workspace.companyId}/${room.room_id}`)}>
              <span>
                <strong>{room.name}</strong>
                {room.project_name!==room.name&&<small>{room.project_name}</small>}
              </span>
              <ChevronRight size={16}/>
            </button>
          </li>)}
      </ul>}
    </section>

    <section className="home-section" aria-labelledby="home-agents">
      <div className="home-section-head">
        <h2 id="home-agents">Agents</h2>
        {agents.length>0&&!addingAgent&&
          <button type="button" className="home-action" onClick={()=>setAddingAgent(true)}><Plus size={13}/>Connect existing agent</button>}
      </div>

      {agents.length===0&&!addingAgent&&<div className="home-empty">
        <p>No agents yet. Multiplayer AI does not run agents for you — connect one you already run.</p>
        <button type="button" className="home-primary" onClick={()=>setAddingAgent(true)}><Plus size={14}/>Connect an existing agent</button>
      </div>}

      {addingAgent&&<ConnectExistingAgent companyId={workspace.companyId}
        onCancel={()=>setAddingAgent(false)}
        onAdded={async()=>{setAddingAgent(false);await load()}}/>}

      {agents.length>0&&<ul className="home-agents">
        {agents.map(agent=>{
          const state=connectionOf(agent);
          return <li key={agent.principal_id}>
            <span className="identity-mark agent" aria-hidden="true">{agent.display_name.slice(0,1).toUpperCase()}</span>
            <span className="home-agent-copy">
              <strong>{agent.display_name}</strong>
              <small className={`connect-state ${state.tone}`}><span className="state-dot" aria-hidden="true"/>{state.label}</small>
            </span>
            {/* Where it works, from real membership rather than an assumption. */}
            <span className="home-agent-rooms">
              {agent.rooms?.length ? agent.rooms.map(room=>room.name).join(', ') : 'No room yet'}
            </span>
          </li>;
        })}
      </ul>}
    </section>
  </main>;
}

/** A room is a name, an objective, and whichever agents you choose — never all of them by default. */
function CreateRoom({companyId,agents,onCancel,onCreated}:{
  companyId:string;agents:WorkspaceAgent[];onCancel:()=>void;onCreated:(room:WorkspaceRoom)=>void}){
  const [name,setName]=useState('');
  const [objective,setObjective]=useState('');
  const [chosen,setChosen]=useState<string[]>([]);
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus()},[]);

  const submit=async(event:FormEvent)=>{
    event.preventDefault();
    if(!name.trim()||!objective.trim()||busy)return;
    setBusy(true);setProblem('');
    try{
      const project=await createProject(companyId,name.trim(),objective.trim());
      const room=await createRoom(companyId,project.id,name.trim());
      for(const principalId of chosen)await addRoomMember(companyId,room.id,principalId,'');
      onCreated({room_id:room.id,name:room.name,project_id:project.id,project_name:project.name});
    }catch(failure){
      setProblem(failure instanceof ApiError?failure.message:'That did not work. Try again.');
      setBusy(false);
    }
  };

  return <form className="home-form" onSubmit={submit}>
    <label className="field">
      <span className="field-label">Room name</span>
      <input ref={field} value={name} placeholder="Rate-limit policy" maxLength={100} disabled={busy}
        onChange={event=>setName(event.target.value)}/>
    </label>
    <label className="field">
      <span className="field-label">What are they trying to achieve?</span>
      <textarea value={objective} rows={2} maxLength={4000} disabled={busy}
        placeholder="Publish a rate-limit policy we can actually honour"
        onChange={event=>setObjective(event.target.value)}/>
    </label>

    {agents.length>0&&<fieldset className="home-choose">
      <legend className="field-label">Which agents belong here?</legend>
      {agents.map(agent=>
        <label key={agent.principal_id} className="home-check">
          <input type="checkbox" checked={chosen.includes(agent.principal_id)} disabled={busy}
            onChange={event=>setChosen(current=>event.target.checked
              ? [...current,agent.principal_id]
              : current.filter(id=>id!==agent.principal_id))}/>
          <span>{agent.display_name}</span>
        </label>)}
      <small className="home-note">You can add agents later. A room can start empty.</small>
    </fieldset>}

    {problem&&<p className="form-error" role="alert">{problem}</p>}
    <div className="home-form-actions">
      <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button disabled={busy||!name.trim()||!objective.trim()}>{busy?'Creating…':'Create room'}</button>
    </div>
  </form>;
}

/** Registering an identity for an agent the person already runs. Connecting it happens on its Mac. */
function ConnectExistingAgent({companyId,onCancel,onAdded}:{
  companyId:string;onCancel:()=>void;onAdded:()=>Promise<void>}){
  const [name,setName]=useState('');
  const [busy,setBusy]=useState(false);
  const [problem,setProblem]=useState('');
  const field=useRef<HTMLInputElement>(null);
  useEffect(()=>{field.current?.focus()},[]);

  return <form className="home-form" onSubmit={async event=>{
    event.preventDefault();
    if(!name.trim()||busy)return;
    setBusy(true);setProblem('');
    try{await addWorkspaceAgent(companyId,name.trim());await onAdded()}
    catch(failure){setProblem(failure instanceof ApiError?failure.message:'That did not work.');setBusy(false)}
  }}>
    <label className="field">
      <span className="field-label">Agent name</span>
      <input ref={field} value={name} placeholder="Research agent" maxLength={100} disabled={busy}
        onChange={event=>setName(event.target.value)}/>
    </label>
    <small className="home-note">
      Names an agent you already run. Put it in a room, then connect it from the Mac it runs on
      using the Multiplayer AI Connector.
    </small>
    {problem&&<p className="form-error" role="alert">{problem}</p>}
    <div className="home-form-actions">
      <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
      <button disabled={busy||!name.trim()}>{busy?'Adding…':'Add agent'}</button>
    </div>
  </form>;
}
