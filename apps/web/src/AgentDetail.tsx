import {useEffect,useRef,useState} from 'react';
import {X} from 'lucide-react';
import {ApiError,disconnectWorkspaceAgent,removeWorkspaceAgent,type WorkspaceAgent} from './api';
import {connectionOf} from './Welcome';
import {runtimeLabel} from './Home';

/**
 * One agent, in full.
 *
 * The list answers "which agents do I have"; this answers "what is this one doing, and where".
 * Everything here is what the workspace was told by the Mac that runs the agent — its runtime, its
 * local profile, the machine, the session — shown as reported and never treated as authority.
 * Stopping it and removing it both live here, because both are about this agent and neither
 * belongs on a row somebody is scanning.
 */
export function AgentDetail({companyId,agent,onClose,onChanged}:{
  companyId:string;agent:WorkspaceAgent;onClose:()=>void;onChanged:()=>Promise<void>|void}){
  const [busy,setBusy]=useState<'disconnect'|'remove'|null>(null);
  const [problem,setProblem]=useState('');
  const [confirmingRemove,setConfirmingRemove]=useState(false);
  const close=useRef<HTMLButtonElement>(null);
  useEffect(()=>{close.current?.focus()},[]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();onClose()}};
    window.addEventListener('keydown',key);
    return()=>window.removeEventListener('keydown',key);
  },[onClose]);

  const state=connectionOf(agent);
  const working=agent.connector.runtime_status==='working';
  const run=async(what:'disconnect'|'remove',action:()=>Promise<unknown>)=>{
    setBusy(what);setProblem('');
    try{await action();await onChanged();if(what==='remove')onClose()}
    catch(failure){setProblem(failure instanceof ApiError?failure.message:'That did not work. Try again.')}
    finally{setBusy(null)}
  };

  const rows:Array<[string,string]>=[
    ['State',working?`${state.label} · working now`:state.label],
    ['Current room',agent.connector.room_name??(agent.rooms?.length?agent.rooms.map(room=>room.name).join(', '):'No room yet')],
    ['Runtime',runtimeLabel(agent)??'Not reported'],
    ['Local profile',agent.connector.profile??'Not reported'],
    ['Device',agent.connector.device??'Not reported'],
    ['Session',sessionState(agent)],
    ['Last activity',agent.connector.last_seen_at?when(agent.connector.last_seen_at):'Never'],
    ['Owner',agent.owners?.length?agent.owners.map(owner=>owner.display_name).join(', '):(agent.owner_display_name??'—')],
  ];

  return <div className="agent-sheet-scrim" role="presentation" onMouseDown={event=>{if(event.target===event.currentTarget)onClose()}}>
    <section className="agent-detail" role="dialog" aria-modal="true" aria-label={`${agent.display_name} details`}>
      <header>
        <span className="identity-mark agent" aria-hidden="true">{agent.display_name.slice(0,1).toUpperCase()}</span>
        <div className="agent-detail-title">
          <h2>{agent.display_name}</h2>
          <small className={`connect-state ${state.tone}`}><span className="state-dot" aria-hidden="true"/>{state.label}</small>
        </div>
        {/* Removing an agent belongs to the agent, in its own corner, behind a confirmation. */}
        <button type="button" className="danger-link" disabled={busy!==null}
          onClick={()=>setConfirmingRemove(true)}>Remove agent</button>
        <button ref={close} type="button" className="agent-detail-close" aria-label="Close" onClick={onClose}><X size={16}/></button>
      </header>

      <dl className="agent-detail-rows">
        {rows.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}
      </dl>

      {confirmingRemove
        ? <div className="agent-detail-confirm" role="alertdialog" aria-label={`Remove ${agent.display_name}?`}>
            <p><strong>Remove {agent.display_name}?</strong> Its credentials and sessions are revoked and it leaves
              every room. What it already did stays in the room history.</p>
            <div className="agent-detail-actions">
              <button type="button" onClick={()=>setConfirmingRemove(false)} disabled={busy!==null}>Cancel</button>
              <button type="button" className="danger-action" disabled={busy!==null}
                onClick={()=>run('remove',()=>removeWorkspaceAgent(companyId,agent.principal_id))}>
                {busy==='remove'?'Removing…':'Remove agent'}</button>
            </div>
          </div>
        : <div className="agent-detail-actions">
            <button type="button" disabled={busy!==null||!state.arrived}
              onClick={()=>run('disconnect',()=>disconnectWorkspaceAgent(companyId,agent.principal_id))}>
              {busy==='disconnect'?'Disconnecting…':'Disconnect'}</button>
            {/* Reconnecting happens on the Mac that runs it: only that Mac holds its credential. */}
            <a className="home-primary" href={`multiplayerai://connect-runtime?agent=${agent.principal_id}`}>Reconnect</a>
          </div>}

      <p className="home-note">Disconnect ends its live session and keeps its identity and credential.
        Reconnect opens the Mac it runs on.</p>
      {problem&&<p className="form-error" role="alert">{problem}</p>}
    </section>
  </div>;
}

/** The session as the workspace has it, without exposing an id. */
function sessionState(agent:WorkspaceAgent){
  const {session_status,connected_at,disconnected_at}=agent.connector;
  if(!session_status)return agent.connector.enrolled?'No session yet':'Not connected yet';
  if(session_status==='connected')return connected_at?`Live since ${when(connected_at)}`:'Live';
  const ended=disconnected_at?` · ended ${when(disconnected_at)}`:'';
  return `${session_status}${ended}`;
}

function when(at:string){
  const date=new Date(at);
  if(Number.isNaN(date.getTime()))return 'Unknown';
  return date.toDateString()===new Date().toDateString()
    ? date.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'})
    : date.toLocaleString([],{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
}
