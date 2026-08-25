import WebSocket from "ws";
import { SequenceTracker } from "../apps/api/src/realtime/protocol.js";

const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

export class FakeExternalAgentClient {
  credentialToken?:string;
  sessionId?:string;
  sessionToken?:string;
  roomId?:string;
  readonly frames:any[]=[];
  readonly applied=new Map<number,any>();
  readonly gaps:number[]=[];
  socket?:WebSocket;
  tracker=new SequenceTracker(0);

  constructor(readonly baseUrl:string) {}
  private async request(method:string,path:string,body?:unknown,token=this.sessionToken,idempotencyKey?:string) {
    const response=await fetch(`${this.baseUrl}${path}`,{method,headers:{...(token?{authorization:`Bearer ${token}`}:{ }),...(body?{"content-type":"application/json"}:{}),...(idempotencyKey?{"idempotency-key":idempotencyKey}:{})},body:body?JSON.stringify(body):undefined});
    const value=await response.json();
    return {status:response.status,body:value};
  }
  async discover(credentialToken=this.credentialToken!){return this.request("GET","/v1/agent-gateway/v1/rooms",undefined,credentialToken)}
  async open(credentialToken=this.credentialToken!,roomId=this.roomId!){const r=await this.request("POST","/v1/agent-gateway/v1/sessions",{room_id:roomId},credentialToken);if(r.status===200){this.credentialToken=credentialToken;this.roomId=roomId;this.sessionId=r.body.session_id;this.sessionToken=r.body.session_token}return r}
  async snapshot(){return this.request("GET",`/v1/agent-gateway/v1/sessions/${this.sessionId}/snapshot`)}
  async tasks(){return this.request("GET",`/v1/agent-gateway/v1/sessions/${this.sessionId}/tasks`)}
  async task(id:string){return this.request("GET",`/v1/agent-gateway/v1/sessions/${this.sessionId}/tasks/${id}`)}
  async message(body:string,key:string,addressedPrincipalId?:string){return this.request("POST",`/v1/agent-gateway/v1/sessions/${this.sessionId}/messages`,{body,...(addressedPrincipalId?{addressed_principal_id:addressedPrincipalId}:{})},this.sessionToken,key)}
  async updateTask(id:string,status:string,expectedVersion:number,key:string){return this.request("PATCH",`/v1/agent-gateway/v1/sessions/${this.sessionId}/tasks/${id}/status`,{status,expected_version:expectedVersion},this.sessionToken,key)}
  async completeTask(id:string,expectedVersion:number,key:string){return this.request("POST",`/v1/agent-gateway/v1/sessions/${this.sessionId}/tasks/${id}/complete`,{expected_version:expectedVersion},this.sessionToken,key)}
  async requestDecision(input:{title:string;question:string;rationale?:string;proposed_action:Record<string,unknown>},key:string){return this.request("POST",`/v1/agent-gateway/v1/sessions/${this.sessionId}/decisions`,input,this.sessionToken,key)}
  async decision(id:string){return this.request("GET",`/v1/agent-gateway/v1/sessions/${this.sessionId}/decisions/${id}`)}
  async heartbeat(runtime_status:"idle"|"working"){return this.request("POST",`/v1/agent-gateway/v1/sessions/${this.sessionId}/heartbeat`,{runtime_status})}
  async disconnect(){return this.request("POST",`/v1/agent-gateway/v1/sessions/${this.sessionId}/disconnect`,{})}

  async connect(afterSeq?:number,autoAck=true,freshSnapshot=false) {
    this.close();
    const cursor=afterSeq??this.tracker.contiguousSeq;
    const query=freshSnapshot?"":`?after_seq=${cursor}`;
    const url=`${this.baseUrl.replace("http","ws")}/v1/agent-gateway/v1/sessions/${this.sessionId}/stream${query}`;
    this.socket=new WebSocket(url,{headers:{authorization:`Bearer ${this.sessionToken}`}});
    this.socket.on("message",raw=>{
      const frame=JSON.parse(raw.toString());this.frames.push(frame);
      if(frame.type==="room.snapshot")this.tracker=new SequenceTracker(frame.snapshot_seq);
      if(frame.type==="session.ready"&&typeof frame.after_seq==="number")this.tracker=new SequenceTracker(frame.after_seq);
      if(frame.type==="room.event"){
        const seen=this.tracker.observe(frame.event.room_seq);
        if(seen==="gap")this.gaps.push(frame.event.room_seq);
        if(seen==="next"){this.applied.set(frame.event.room_seq,frame.event);if(autoAck&&this.socket?.readyState===WebSocket.OPEN)this.socket.send(JSON.stringify({type:"ack",room_seq:this.tracker.contiguousSeq}))}
      }
    });
    return this.waitFor(f=>["session.ready","protocol_error","resync_required"].includes(f.type));
  }
  async waitFor(predicate:(frame:any)=>boolean,timeout=3000){const start=Date.now();while(Date.now()-start<timeout){const frame=this.frames.find(predicate);if(frame)return frame;await sleep(10)}throw new Error(`Timed out: ${JSON.stringify(this.frames)}`)}
  close(){if(this.socket&&(this.socket.readyState===WebSocket.OPEN||this.socket.readyState===WebSocket.CONNECTING))this.socket.close()}
}
