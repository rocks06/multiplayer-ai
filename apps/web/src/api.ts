import type {ApiErrorShape,Decision,RoomIdentity,RoomSnapshot,TaskStatus} from './types';

const commandKey=()=>{
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
  constructor(message:string,readonly code:string,readonly status:number){super(message)}
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
      throw new ApiError(body.error?.message??`Request failed (${response.status})`,body.error?.code??'unknown',response.status);
    }
    return response.json() as Promise<T>;
  }
  snapshot(){return this.request<RoomSnapshot>('/snapshot')}
  decisions(){return this.request<{decisions:Decision[]}>('/decisions?status=pending')}
  sendMessage(body:string,addressedPrincipalId?:string){return this.request('/messages',{method:'POST',headers:{'idempotency-key':commandKey()},body:JSON.stringify({body,addressed_principal_id:addressedPrincipalId||undefined})})}
  createTask(input:{title:string;description:string;assigneePrincipalId?:string}){return this.request('/tasks',{method:'POST',headers:{'idempotency-key':commandKey()},body:JSON.stringify({title:input.title,description:input.description,assignee_principal_id:input.assigneePrincipalId||undefined})})}
  updateTask(taskId:string,status:TaskStatus,expectedVersion:number){return this.request(`/tasks/${taskId}/status`,{method:'PATCH',headers:{'idempotency-key':commandKey()},body:JSON.stringify({status,expected_version:expectedVersion})})}
  /** The key is stable per decision and outcome, so a double submission returns the original
   *  result instead of colliding on the version it already advanced. */
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

export interface SignedInIdentity {user:{id:string;email:string;display_name:string};companies:Array<{company_id:string;company_name:string;principal_id:string;display_name:string}>}

export async function requestSignInLink(email:string){
  const response=await fetch('/v1/auth/sign-in-links',{method:'POST',headers:{'content-type':'application/json'},credentials:'same-origin',body:JSON.stringify({email})});
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
