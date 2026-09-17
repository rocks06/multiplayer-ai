import type {ApiErrorShape,CompanyAgent,Decision,RoomIdentity,RoomSnapshot,TaskStatus,ReadPosition} from './types';

export const commandKey=()=>{
 const webCrypto=globalThis.crypto;
 if(typeof webCrypto.randomUUID==='function')return webCrypto.randomUUID();
 const bytes=webCrypto.getRandomValues(new Uint8Array(16));
 bytes[6]=((bytes[6]??0)&0x0f)|0x40;
 bytes[8]=((bytes[8]??0)&0x3f)|0x80;
 const hex=Array.from(bytes,byte=>byte.toString(16).padStart(2,'0')).join('');
 return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
};

/** Carries the server's own error code, so callers can say something better than a status number. */
export class ApiError extends Error{
  constructor(message:string,readonly code:string,readonly status:number,readonly details?:Record<string,unknown>){super(message)}
}

export class RoomApi {
  constructor(readonly identity:RoomIdentity){}
  private get base(){return `/v1/companies/${this.identity.companyId}/rooms/${this.identity.roomId}`}
  private async request<T>(path:string,init:RequestInit={}):Promise<T>{
    const headers=new Headers(init.headers);
    if(init.body)headers.set('content-type','application/json');
    const response=await fetch(`${this.base}${path}`,{...init,headers,credentials:'same-origin'});
    if(!response.ok){
      const body=await response.json().catch(()=>({})) as ApiErrorShape;
      throw new ApiError(body.error?.message??`Request failed (${response.status})`,body.error?.code??'unknown',response.status,body.error?.details);
    }
    return response.json() as Promise<T>;
  }
  snapshot(){return this.request<RoomSnapshot>('/snapshot')}
  createInvite(ttlHours=24){return this.request<{id:string;invite_token:string;invite_path:string;expires_at:string}>('/invites',{method:'POST',body:JSON.stringify({ttl_hours:ttlHours})})}
  decisions(){return this.request<{decisions:Decision[]}>('/decisions?status=pending')}
  sendMessage(body:string,addressedPrincipalId?:string,artifactIds:string[]=[],key=commandKey(),mentions:{principal_id:string;start:number;end:number}[]=[]){return this.request('/messages',{method:'POST',headers:{'idempotency-key':key},body:JSON.stringify({body,addressed_principal_id:addressedPrincipalId||undefined,artifact_ids:artifactIds,...(mentions.length?{mentions}:{})})})}
  /** Forward only, on the server: marking an older position read never makes anything unread. */
  readPositions(){return this.request<{read_positions:ReadPosition[]}>('/read-positions')}
  markRead(roomSeq:number){return this.request<{last_read_seq:number}>('/read',{method:'POST',body:JSON.stringify({room_seq:roomSeq})})}
  artifacts(){return this.request<{artifacts:import('./types').Artifact[]}>('/artifacts')}
  async uploadArtifact(file:File){
    const query=new URLSearchParams({filename:file.name,content_type:file.type||'application/octet-stream'});
    const response=await fetch(`${this.base}/artifacts?${query}`,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/octet-stream'},body:file});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error?.message??'Upload failed. Retry this file.');}
    return response.json() as Promise<import('./types').Artifact>;
  }
  async artifactBytes(id:string){
    const response=await fetch(`${this.base}/artifacts/${encodeURIComponent(id)}/content`,{credentials:'same-origin',redirect:'error'});
    if(!response.ok){const data=await response.json().catch(()=>({}));throw new Error(data.error?.message??'File unavailable. Retry or ask the sender to upload it again.');}
    return response.blob();
  }
  createTask(input:{title:string;description:string;assigneePrincipalId?:string}){return this.request('/tasks',{method:'POST',headers:{'idempotency-key':commandKey()},body:JSON.stringify({title:input.title,description:input.description,assignee_principal_id:input.assigneePrincipalId||undefined})})}
  updateTask(taskId:string,status:TaskStatus,expectedVersion:number){return this.request(`/tasks/${taskId}/status`,{method:'PATCH',headers:{'idempotency-key':`task-${taskId}-${status}-v${expectedVersion}`},body:JSON.stringify({status,expected_version:expectedVersion})})}
  /** The key is stable per decision and outcome, so a double submission returns the original
   *  result instead of colliding on the version it already advanced. */
  /* Reassigning, cancelling, and starting all carry the version they were decided from, so a
     repeated submission returns the original result instead of acting twice. */
  reassignTask(taskId:string,assigneePrincipalId:string|null,expectedVersion:number){
    return this.request(`/tasks/${taskId}/assignee`,{method:'PATCH',
      headers:{'idempotency-key':`task-${taskId}-assignee-v${expectedVersion}`},
      body:JSON.stringify({assignee_principal_id:assigneePrincipalId,expected_version:expectedVersion})})}
  addDependency(taskId:string,dependsOnTaskId:string){
    return this.request(`/tasks/${taskId}/dependencies`,{method:'POST',
      headers:{'idempotency-key':`task-${taskId}-dep-add-${dependsOnTaskId}`},
      body:JSON.stringify({depends_on_task_id:dependsOnTaskId})})}
  removeDependency(taskId:string,dependsOnTaskId:string){
    return this.request(`/tasks/${taskId}/dependencies/${dependsOnTaskId}`,{method:'DELETE',
      headers:{'idempotency-key':`task-${taskId}-dep-remove-${dependsOnTaskId}`}})}
  /** Recorded in the room under the manager's name, with the reason they gave. */
  overrideDependencies(taskId:string,reason:string){
    return this.request(`/tasks/${taskId}/dependency-override`,{method:'POST',
      headers:{'idempotency-key':commandKey()},body:JSON.stringify({reason})})}
  /* Pause and resume address the agent record rather than its room principal, and whether an
     agent is paused is a company-level fact, so both come from the company agent list. */
  async companyAgents():Promise<CompanyAgent[]>{
    const response=await fetch(`/v1/companies/${this.identity.companyId}/agents`,{credentials:'same-origin'});
    if(!response.ok){
      const problem=await response.json().catch(()=>({})) as ApiErrorShape;
      throw new ApiError(problem.error?.message??`Request failed (${response.status})`,problem.error?.code??'unknown',response.status,problem.error?.details);
    }
    const payload=await response.json() as {agents?:CompanyAgent[]};
    return payload.agents??[];
  }
  pauseAgent(agentId:string){return this.request(`/agents/${agentId}/pause`,{method:'POST',headers:{'idempotency-key':commandKey()}})}
  resumeAgent(agentId:string){return this.request(`/agents/${agentId}/resume`,{method:'POST',headers:{'idempotency-key':commandKey()}})}
  disconnectMember(principalId:string){return this.request(`/members/${principalId}`,{method:'DELETE',headers:{'idempotency-key':commandKey()}})}
  /** Leave this room only. The server ends a live session first, in the same command, and keeps the
   *  agent's identity and credential; it stays available for any other room. */
  removeMember(principalId:string){return this.request(`/members/${principalId}`,{method:'DELETE',headers:{'idempotency-key':commandKey()}})}

  resolveDecision(decision:Decision,resolution:'approve'|'reject',note:string){return this.request(`/decisions/${decision.id}/${resolution}`,{method:'POST',headers:{'idempotency-key':`decision-${decision.id}-${resolution}-v${decision.version}`},body:JSON.stringify({proposed_action_digest:decision.proposed_action_digest,expected_version:decision.version,note:note||undefined})})}
  streamUrl(afterSeq?:number){
    const scheme=location.protocol==='https:'?'wss':'ws';
    const params=new URLSearchParams();
    if(afterSeq!==undefined)params.set('after_seq',String(afterSeq));
    return `${scheme}://${location.host}${this.base}/stream?${params}`;
  }
}

export function roomFromLocation():{companyId:string;roomId:string}|null{
  const match=location.pathname.match(/^\/rooms\/([0-9a-f-]+)\/([0-9a-f-]+)\/?$/i);
  if(!match?.[1]||!match[2])return null;
  return {companyId:match[1],roomId:match[2]};
}

export interface SignedInIdentity {user:{id:string;email:string;display_name:string};companies:Array<{company_id:string;company_name:string;principal_id:string;display_name:string;access_scope?:'workspace'|'room_only'}>}

/* `context:'web'` is the whole of the invite fix on this side.

   Without it the server cannot tell a browser from the Mac app, so every link went to the page
   that hands tokens to the app — spending the single-use token somewhere this tab would never
   hear about, and stranding the invitation it was in the middle of accepting. */
export async function requestSignInLink(email:string){
  const response=await fetch('/v1/auth/sign-in-links',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({email,context:'web'})});
  if(!response.ok){
    const body=await response.json().catch(()=>({})) as ApiErrorShape;
    throw new Error(body.error?.message??'Could not issue a sign-in link');
  }
  return response.json() as Promise<{status:string}>;
}

/** Exchange a single-use link for a session. Rejects when the link is spent or expired. */
export async function redeemSignInToken(token:string):Promise<SignedInIdentity>{
  const response=await fetch('/v1/auth/sessions',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({token})});
  if(!response.ok)throw new Error('Sign-in link is invalid, already used, or expired');
  return response.json() as Promise<SignedInIdentity>;
}

/** Identity comes from the session cookie. The client never names a principal. */
export async function currentIdentity():Promise<SignedInIdentity|null>{
  const response=await fetch('/v1/auth/me',{credentials:'same-origin'});
  if(response.status===401)return null;
  if(!response.ok)throw new Error('Could not load your account');
  return response.json() as Promise<SignedInIdentity>;
}

/* Setting a workspace up is company-scoped rather than room-scoped, so these stand outside
   RoomApi. Every one of them is the same authenticated route the rest of the product uses. */
async function send<T>(path:string,init:RequestInit={}):Promise<T>{
  const headers=new Headers(init.headers);
  if(init.body)headers.set('content-type','application/json');
  const response=await fetch(path,{...init,headers,credentials:'same-origin'});
  if(!response.ok){
    const body=await response.json().catch(()=>({})) as ApiErrorShape;
    throw new ApiError(body.error?.message??`Request failed (${response.status})`,body.error?.code??'unknown',response.status,body.error?.details);
  }
  return response.json() as Promise<T>;
}

export interface WorkspaceAgent {
  agent_id:string;principal_id:string;display_name:string;status:'active'|'paused'|'archived';
  owner_display_name:string|null;
  connector:{enrolled:boolean;presence:'connected'|'stale'|'offline'|'revoked'|'superseded'|'never';runtime_status:string|null;last_seen_at:string|null;room_id:string|null;room_name:string|null;
    /** Its session, and where it runs — reported by the connector about itself. */
    session_status?:string|null;connected_at?:string|null;disconnected_at?:string|null;profile?:string|null;device?:string|null};
  rooms:Array<{room_id:string;name:string}>|null;
  /** The runtime this agent was connected from, when the workspace knows it. Shown, never trusted. */
  runtime?:{type:string;version:string|null}|null;
  /** The people who own this agent, recorded rather than inferred from its name. */
  owners?:Array<{principal_id:string;display_name:string}>;
}
/** What in a room needs this person, from their own read position. */
export interface RoomAttention {unread_count?:number;mention_count?:number;action_count?:number;last_read_seq?:number;last_event_seq?:number;
  latest?:{event_type:string;actor_display_name:string;actor_kind:string;text:string|null;created_at:string;room_seq:number}|null}
export interface WorkspaceRoom extends RoomAttention {room_id:string;name:string;project_id:string;project_name:string;objective?:string;notification_level?:NotificationLevel}

/** How much a person wants to be told about one room. Native notifications only; never unread. */
export type NotificationLevel='all'|'direct_mentions'|'mentions'|'important'|'off';
export const NOTIFICATION_CHOICES:Array<{level:NotificationLevel;label:string;detail:string}>=[
  {level:'all',label:'All activity',detail:'Everything in the room, except agents\u2019 turns with each other.'},
  {level:'direct_mentions',label:'Direct, mentions and Needs you',detail:'Sent to you, naming you, or waiting on you. The default.'},
  {level:'mentions',label:'Mentions only',detail:'Only when somebody writes your name.'},
  {level:'important',label:'Important only',detail:'Only decisions and blocked work that need a person.'},
  {level:'off',label:'Off',detail:'No notifications. Unread still counts, as it always does.'},
];

export const roomNotificationPreference=(companyId:string,roomId:string)=>
  send<{room_id:string;level:NotificationLevel}>(`/v1/companies/${companyId}/rooms/${roomId}/notification-preference`);

export const setRoomNotificationPreference=(companyId:string,roomId:string,level:NotificationLevel)=>
  send<{room_id:string;level:NotificationLevel}>(`/v1/companies/${companyId}/rooms/${roomId}/notification-preference`,
    {method:'PUT',body:JSON.stringify({level})});

/** End its live sessions. Its credential, identity and rooms are kept; its Mac brings it back. */
export const disconnectWorkspaceAgent=(companyId:string,principalId:string)=>
  send<{agent_principal_id:string;sessions_ended:number}>(`/v1/companies/${companyId}/agents/${principalId}/disconnect`,{method:'POST'});

export const createWorkspace=(name:string)=>
  send<{company_id:string;name:string;principal_id:string}>('/v1/workspaces',{method:'POST',body:JSON.stringify({name})});

export const listWorkspaceAgents=(companyId:string)=>
  send<{agents:WorkspaceAgent[]}>(`/v1/companies/${companyId}/agents`).then(r=>r.agents);

/* Always a list. The sidebar and the room list both iterate this, and a response that is merely
   shaped differently than expected should leave them empty rather than take the page down. */
export const listWorkspaceRooms=(companyId:string)=>
  send<{rooms:WorkspaceRoom[]}>(`/v1/companies/${companyId}/rooms`)
    .then(r=>Array.isArray(r?.rooms)?r.rooms:[]);

/** The owner is the signed-in person; the server resolves it and the client cannot choose. */
export const addWorkspaceAgent=(companyId:string,name:string)=>
  send<{agent_id:string;principal_id:string}>(`/v1/companies/${companyId}/agents`,{method:'POST',body:JSON.stringify({name})});

export const removeWorkspaceAgent=(companyId:string,principalId:string)=>
  send<{principal_id:string;status:'removed'}>(`/v1/companies/${companyId}/agents/${principalId}`,{method:'DELETE'});

export const deleteWorkspaceRoom=(companyId:string,roomId:string)=>
  send<{id:string;status:'deleted'}>(`/v1/companies/${companyId}/rooms/${roomId}`,{method:'DELETE'});

/** A code is for one agent in one room. The room is not optional in the product, only in the
 *  wire format, because codes issued before rooms were carried have no room to name. */
export const createEnrollmentCode=(companyId:string,agentPrincipalId:string,label:string,roomId:string)=>
  send<{enrollment_code:string;expires_at:string;room_id:string|null}>(`/v1/companies/${companyId}/agents/${agentPrincipalId}/enrollments`,
    {method:'POST',body:JSON.stringify({label,room_id:roomId})});

export const createProject=(companyId:string,name:string,objective:string)=>
  send<{id:string;name:string;objective:string}>(`/v1/companies/${companyId}/projects`,{method:'POST',body:JSON.stringify({name,objective})});

export const setProjectObjective=(companyId:string,projectId:string,objective:string,expectedObjective:string)=>
  send<{id:string;name:string;objective:string}>(`/v1/companies/${companyId}/projects/${projectId}/objective`,
    {method:'PATCH',body:JSON.stringify({objective,expected_objective:expectedObjective})});

export const createRoom=(companyId:string,projectId:string,name:string)=>
  send<{id:string;name:string}>(`/v1/companies/${companyId}/projects/${projectId}/rooms`,{method:'POST',body:JSON.stringify({name})});

export const addRoomMember=(companyId:string,roomId:string,principalId:string,responsibilities:string)=>
  send<unknown>(`/v1/companies/${companyId}/rooms/${roomId}/members`,{method:'POST',
    headers:{'idempotency-key':`member-${roomId}-${principalId}`},
    body:JSON.stringify({principal_id:principalId,role:'worker_agent',responsibilities})});

/** Creating an account: the same magic link signing in uses, for someone who has none yet. */
export const signUp=(name:string,email:string)=>
  // Same reason as signing in: creating an account from an invitation must come back to the tab
  // holding that invitation, not to the Mac app.
  send<{status:string}>('/v1/auth/sign-up',{method:'POST',body:JSON.stringify({name,email,context:'web'})});

export const signOut=()=>send<unknown>('/v1/auth/sessions/current',{method:'DELETE'});

export interface RoomInvitePreview {company_name:string;room_name:string;expires_at:string}
export interface AcceptedRoomInvite {company_id:string;room_id:string;principal_id:string;company_name:string;room_name:string;room_path:string}
export const previewRoomInvite=(token:string)=>send<RoomInvitePreview>('/v1/room-invites/preview',{method:'POST',body:JSON.stringify({token})});
export const acceptRoomInvite=(token:string)=>send<AcceptedRoomInvite>('/v1/room-invites/accept',{method:'POST',body:JSON.stringify({token})});

/**
 * How sign-in links actually reach people, asked of the server rather than assumed.
 *
 * The wording on the sign-in screens depends on it: telling somebody to check their email when
 * nothing is being sent is the developer-beta note that has to disappear the moment real
 * delivery is on — and has to stay while it is not.
 */
export type SignInDelivery='resend'|'logging'|'silent'|'custom';
export const signInDelivery=()=>
  fetch('/v1/app-config',{credentials:'same-origin'})
    .then(response=>response.ok?response.json() as Promise<{sign_in_delivery:SignInDelivery}>:null)
    .then(config=>config?.sign_in_delivery??'logging')
    .catch(()=>'logging' as SignInDelivery);

