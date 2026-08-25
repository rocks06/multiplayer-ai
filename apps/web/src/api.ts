import type {ApiErrorShape,Decision,RoomIdentity,RoomSnapshot,TaskStatus} from './types';

const commandKey=()=>crypto.randomUUID();

export class RoomApi {
  constructor(readonly identity:RoomIdentity){}
  private get base(){return `/v1/companies/${this.identity.companyId}/rooms/${this.identity.roomId}`}
  private async request<T>(path:string,init:RequestInit={}):Promise<T>{
    const headers=new Headers(init.headers);
    headers.set('x-principal-id',this.identity.principalId);
    if(init.body)headers.set('content-type','application/json');
    const response=await fetch(`${this.base}${path}`,{...init,headers});
    if(!response.ok){
      const body=await response.json().catch(()=>({})) as ApiErrorShape;
      throw new Error(body.error?.message??`Request failed (${response.status})`);
    }
    return response.json() as Promise<T>;
  }
  snapshot(){return this.request<RoomSnapshot>('/snapshot')}
  decisions(){return this.request<{decisions:Decision[]}>('/decisions?status=pending')}
  sendMessage(body:string,addressedPrincipalId?:string){return this.request('/messages',{method:'POST',headers:{'idempotency-key':commandKey()},body:JSON.stringify({body,addressed_principal_id:addressedPrincipalId||undefined})})}
  createTask(input:{title:string;description:string;assigneePrincipalId?:string}){return this.request('/tasks',{method:'POST',headers:{'idempotency-key':commandKey()},body:JSON.stringify({title:input.title,description:input.description,assignee_principal_id:input.assigneePrincipalId||undefined})})}
  updateTask(taskId:string,status:TaskStatus,expectedVersion:number){return this.request(`/tasks/${taskId}/status`,{method:'PATCH',headers:{'idempotency-key':commandKey()},body:JSON.stringify({status,expected_version:expectedVersion})})}
  resolveDecision(decision:Decision,resolution:'approve'|'reject',note:string){return this.request(`/decisions/${decision.id}/${resolution}`,{method:'POST',headers:{'idempotency-key':commandKey()},body:JSON.stringify({proposed_action_digest:decision.proposed_action_digest,expected_version:decision.version,note:note||undefined})})}
  streamUrl(afterSeq?:number){
    const scheme=location.protocol==='https:'?'wss':'ws';
    const params=new URLSearchParams({principal_id:this.identity.principalId});
    if(afterSeq!==undefined)params.set('after_seq',String(afterSeq));
    return `${scheme}://${location.host}${this.base}/stream?${params}`;
  }
}

export function identityFromLocation():RoomIdentity|null{
  const match=location.pathname.match(/^\/rooms\/([0-9a-f-]+)\/([0-9a-f-]+)\/?$/i);
  const principalId=new URLSearchParams(location.search).get('principal')??sessionStorage.getItem('multiplayer-principal');
  if(!match?.[1]||!match[2]||!principalId)return null;
  sessionStorage.setItem('multiplayer-principal',principalId);
  return {companyId:match[1],roomId:match[2],principalId};
}
