import type {WorkspaceAgent} from './api';

/** The browser cannot transfer a machine credential. Hand a confirmed move to its
 * owning native connector; never mint an enrollment code or add membership first. */
export function agentRoomMove(agent:WorkspaceAgent,companyId:string,roomId:string,roomName:string){
  const from=agent.connector.room_id;
  // Only a live session is somewhere to move from. A room the agent was disconnected from is
  // history, and asking to "move" out of it described a connection that did not exist.
  const live=agent.connector.presence==='connected'||agent.connector.presence==='stale';
  if(!live||!from||from===roomId)return null;
  return {
    message:`${agent.display_name} is currently connected to ${agent.connector.room_name??'another room'}. Move it to ${roomName}?`,
    url:`multiplayerai://connect-runtime?company=${encodeURIComponent(companyId)}&room=${encodeURIComponent(roomId)}&agent=${encodeURIComponent(agent.principal_id)}`,
  };
}
export function handoffAgentMove(move:NonNullable<ReturnType<typeof agentRoomMove>>,approve:(message:string)=>boolean,open:(url:string)=>void){
  if(!approve(move.message))return false;
  open(move.url);
  return true;
}

/** Hand an agent that already has a Mac to that Mac, to connect it here with the identity and
 * credential it already holds. Only a never-connected agent needs a code. */
export function connectOnMac(agent:WorkspaceAgent,companyId:string,roomId:string){
  if(!agent.connector.enrolled)return null;
  return `multiplayerai://connect-runtime?company=${encodeURIComponent(companyId)}&room=${encodeURIComponent(roomId)}&agent=${encodeURIComponent(agent.principal_id)}`;
}
