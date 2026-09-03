import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {ChevronRight,Plus} from 'lucide-react';
import {ApiError,addRoomMember,createProject,createRoom,
  listWorkspaceAgents,listWorkspaceRooms,removeWorkspaceAgent,type WorkspaceAgent,type WorkspaceRoom} from './api';
import {connectionOf} from './Welcome';

/**
 * Home answers one question: where is my work?
 *
 * It is navigation and context, not the product. No counts anyone has to interpret, no charts,
 * nothing that needs explaining — the rooms you can open, the agents you have, and the two
 * things you might want to start. Everything shown comes from what the workspace actually
 * contains; nothing here is inferred.
 */
/** One list of rooms. Both sections are the same thing and must not drift apart. */
function RoomList({rooms,onNavigate}:{rooms:HomeRoom[];onNavigate:(to:string)=>void}){
  return <ul className="home-rooms">
    {rooms.map(room=>
      <li key={`${room.companyId}:${room.room_id}`}>
        <button type="button" onClick={()=>onNavigate(`/rooms/${room.companyId}/${room.room_id}`)}>
          <span>
            <strong>{room.name}</strong>
            {room.project_name!==room.name&&<small>{room.project_name}</small>}
          </span>
          <ChevronRight size={16}/>
        </button>
      </li>)}
  </ul>;
}

/** A room, and which workspace it came from — a room is only openable with both. */
export interface HomeRoom extends WorkspaceRoom { companyId:string }
export interface HomeWorkspace {companyId:string;name:string;accessScope?:'workspace'|'room_only'}

export function Home({workspace,memberships,onNavigate}:{
  workspace:HomeWorkspace|null;
  /** Every workspace the server says this person belongs to, however they came to belong to it. */
  memberships?:HomeWorkspace[];
  onNavigate:(to:string)=>void}){
  const [rooms,setRooms]=useState<HomeRoom[]|null>(null);
  const [shared,setShared]=useState<HomeRoom[]>([]);
  const [agents,setAgents]=useState<WorkspaceAgent[]>([]);
  const [creating,setCreating]=useState(false);
  const [addingAgent,setAddingAgent]=useState(false);

  /* Every workspace this person belongs to, not merely the first one.

     A room somebody is invited to individually makes them a room-only member of *that* workspace,
     which arrives as a second entry in the identity. Reading only `companies[0]` meant a room
     joined in a browser could never appear here, however many times the app was relaunched — it
     was in a workspace Home was not looking at. Which section a room belongs in is the server's
     answer too: `room_only` access is what makes it shared rather than one of your own. */
  const scopes=(memberships?.length?memberships:workspace?[workspace]:[]);
  const key=scopes.map(w=>`${w.companyId}:${w.accessScope??'workspace'}`).join(',');
  const load=useCallback(async()=>{
    if(!scopes.length){setRooms([]);setShared([]);setAgents([]);return}
    const found=await Promise.all(scopes.map(async scope=>({
      scope,
      rooms:(await listWorkspaceRooms(scope.companyId).catch(()=>[]))
        .map(room=>({...room,companyId:scope.companyId})),
    })));
    const own:HomeRoom[]=[],invited:HomeRoom[]=[];
    for(const {scope,rooms:list} of found)
      (scope.accessScope==='room_only'?invited:own).push(...list);
    // A room belongs to exactly one section; the workspace it is owned in wins.
    const owned=new Set(own.map(room=>room.room_id));
    setRooms(own);setShared(invited.filter(room=>!owned.has(room.room_id)));
    // Agents are workspace-scoped, so only a workspace membership may ask for them.
    const home=scopes.find(scope=>scope.accessScope!=='room_only');
    setAgents(home?await listWorkspaceAgents(home.companyId).catch(()=>[]):[]);
  },[key]);
  useEffect(()=>{void load()},[load]);

  if(rooms===null)return <main className="home"><p className="auth-quiet" role="status">Loading your workspace…</p></main>;

  if(!workspace)return <main className="home empty-home">
    <section className="empty-home-card">
      <p className="eyebrow">Home</p><h1>Nothing has been created for you.</h1>
      <p>Create a room only when you mean to, join a room you were invited to, or connect the Hermes runtime already running on this Mac.</p>
      <div className="empty-home-actions">
        <button type="button" className="home-primary" onClick={()=>onNavigate('/welcome')}>Create room</button>
        <button type="button" onClick={()=>onNavigate('/join')}>Join room</button>
        <a className="home-secondary" href="multiplayerai://connect-runtime">Connect existing agent</a>
      </div>
    </section>
  </main>;

  return <main className="home">
    <header className="home-head">
      <h1>{workspace.name}</h1>
      <p className="home-lead">Your rooms, and the agents you have connected to them.</p>
    </header>

    <section className="home-section" aria-labelledby="home-rooms" data-onboarding="rooms">
      <div className="home-section-head">
        <h2 id="home-rooms">Your rooms</h2>
        {workspace.accessScope!=='room_only'&&rooms.length>0&&!creating&&
          <button type="button" className="home-action" onClick={()=>setCreating(true)}><Plus size={13}/>Create room</button>}
      </div>

      {rooms.length===0&&!creating&&<div className="home-empty">
        <p>No rooms yet. A room is where your agents work together on one objective.</p>
        {workspace.accessScope!=='room_only'&&<button type="button" className="home-primary" onClick={()=>setCreating(true)}><Plus size={14}/>Create room</button>}
        <button type="button" onClick={()=>onNavigate('/join')}>Join room</button>
      </div>}

      {creating&&<CreateRoom companyId={workspace.companyId} agents={agents}
        onCancel={()=>setCreating(false)}
        onCreated={room=>onNavigate(`/rooms/${workspace.companyId}/${room.room_id}`)}/>}

      {rooms.length>0&&<RoomList rooms={rooms} onNavigate={onNavigate}/>}
    </section>

    {/* Rooms somebody else invited this person into. Kept apart from their own because the two
        are not the same thing to a person: one they made, one they were asked into. */}
    <section className="home-section" aria-labelledby="home-shared">
      <div className="home-section-head"><h2 id="home-shared">Shared rooms</h2></div>
      {shared.length===0
        ? <div className="home-empty"><p>Rooms other people invite you into appear here.</p></div>
        : <RoomList rooms={shared} onNavigate={onNavigate}/>}
    </section>

    <section className="home-section" aria-labelledby="home-agents" data-onboarding="agents">
      <div className="home-section-head">
        <h2 id="home-agents">Agents</h2>
        {workspace.accessScope!=='room_only'&&agents.length>0&&!addingAgent&&
          <button type="button" className="home-action" onClick={()=>setAddingAgent(true)}><Plus size={13}/>Connect existing agent</button>}
      </div>

      {workspace.accessScope!=='room_only'&&agents.length===0&&!addingAgent&&<div className="home-empty">
        <p>No agents yet. Multiplayer AI does not run agents for you — connect one you already run.</p>
        <button type="button" className="home-primary" onClick={()=>setAddingAgent(true)}><Plus size={14}/>Connect an existing agent</button>
      </div>}

      {addingAgent&&<ConnectExistingAgent onCancel={()=>setAddingAgent(false)}/>}

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
            <button type="button" className="danger-link" onClick={async()=>{
              if(!confirm(`Remove ${agent.display_name}? This revokes its active credentials and sessions, and removes it from every room. Historical events remain.`))return;
              await removeWorkspaceAgent(workspace.companyId,agent.principal_id);await load();
            }}>Remove agent</button>
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

/** Discovery and validation happen on the Mac that actually owns the runtime. */
function ConnectExistingAgent({onCancel}:{onCancel:()=>void}){
  return <section className="home-form">
    <h3>Connect the runtime on this Mac</h3>
    <p className="home-note">The Mac app will discover Hermes, show its real version and endpoint, and test it before anything is enrolled.</p>
    <div className="home-form-actions">
      <button type="button" onClick={onCancel}>Cancel</button>
      <a className="home-primary" href="multiplayerai://connect-runtime">Detect Hermes</a>
    </div>
  </section>;
}
