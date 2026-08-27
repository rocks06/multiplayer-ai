import Fastify from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import {existsSync} from "node:fs";
import {resolve} from "node:path";
import { z } from "zod";
import { DomainError } from "../../../packages/domain/src/index.js";
import { createPool, type DbPool } from "./db.js";
import { RoomService } from "./room-service.js";
import { RealtimeHub, type RealtimeOptions } from "./realtime/realtime-hub.js";
import { AgentRuntimeService } from "./agent-runtime/runtime-service.js";
import { AgentGatewayService } from "./agent-gateway/gateway-service.js";
import { registerAgentGatewayRoutes } from "./agent-gateway/gateway-routes.js";
import { AuthService, type SignInLinkDelivery } from "./auth/auth-service.js";

const fakeStep=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('tool'),id:z.string().min(1),name:z.enum(['room.send_message','task.get','task.list_eligible','task.update_status','task.complete','decision.request','decision.get']),arguments:z.record(z.string(),z.unknown())}),
  z.object({kind:z.literal('barrier'),id:z.string().min(1),name:z.string().min(1)}),
  z.object({kind:z.literal('expect_message'),id:z.string().min(1),includes:z.string(),sender_principal_id:z.string().uuid().optional()}),
  z.object({kind:z.literal('expect_decision'),id:z.string().min(1),status:z.enum(['approved','rejected']),note_includes:z.string().optional()}),
  z.object({kind:z.literal('transient_failure'),id:z.string().min(1),times:z.number().int().min(0)}),
  z.object({kind:z.literal('permanent_failure'),id:z.string().min(1),message:z.string()}),
  z.object({kind:z.literal('complete'),id:z.string().min(1)})
]);

const body = <T extends z.ZodTypeAny>(schema:T, value:unknown):z.infer<T> => schema.parse(value);
const SESSION_COOKIE = "mpai_session";
const SESSION_MAX_AGE = 30*24*60*60;
const readSessionCookie = (request:any) => {
  const raw=request.headers.cookie;
  if(typeof raw!=="string") return undefined;
  for(const part of raw.split(";")){ const at=part.indexOf("="); if(at<0) continue; if(part.slice(0,at).trim()===SESSION_COOKIE) return decodeURIComponent(part.slice(at+1).trim()); }
  return undefined;
};
const writeSessionCookie = (reply:any,value:string,maxAge:number,secure:boolean) =>
  reply.header("set-cookie",`${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure?"; Secure":""}`);

export interface AppOptions {
  /** Accept x-principal-id / principal_id. Local development only; never enable in production. */
  allowHeaderPrincipal?: boolean;
  cookieSecure?: boolean;
  signInDelivery?: SignInLinkDelivery;
}
const idem = (request:any) => { const key=request.headers["idempotency-key"]; if(typeof key!=="string") throw new DomainError("idempotency_key_required","Idempotency-Key is required",400); return key; };

export function buildApp(pool:DbPool=createPool(), realtimeOptions:RealtimeOptions={}, options:AppOptions={}) {
  const app=Fastify({logger:false});
  const allowHeaderPrincipal=options.allowHeaderPrincipal ?? process.env.ALLOW_HEADER_PRINCIPAL==="1";
  const cookieSecure=options.cookieSecure ?? process.env.AUTH_COOKIE_SECURE!=="0";
  const auth=new AuthService(pool,options.signInDelivery);
  // The acting principal is resolved from the session and the addressed company. A client can
  // never name it, so knowing a principal id grants nothing.
  const principal=async(request:any,companyId:string)=>{
    if(allowHeaderPrincipal){ const id=request.headers["x-principal-id"]; if(typeof id==="string") return id; }
    const session=await auth.resolveSession(readSessionCookie(request));
    return auth.principalFor(session.userId,companyId);
  };
  const service=new RoomService(pool);
  const agentRuntime=new AgentRuntimeService(pool,service);
  const realtime=new RealtimeHub(pool,service,realtimeOptions);
  const agentGateway=new AgentGatewayService(pool);
  app.register(websocket);
  app.setErrorHandler((error,request,reply)=>{ if(error instanceof DomainError) return reply.status(error.statusCode).send({error:{code:error.code,message:error.message,request_id:request.id,details:error.details}}); if(error instanceof z.ZodError) return reply.status(400).send({error:{code:"validation_error",message:"Invalid request",request_id:request.id,details:error.issues}}); request.log.error(error); return reply.status(500).send({error:{code:"internal_error",message:"Internal server error",request_id:request.id}}); });
  app.get('/health',async()=>({status:'ok'}));
  app.post('/v1/auth/sign-in-links',async req=>{const x=body(z.object({email:z.string().email()}),req.body);return auth.requestSignInLink(x.email)});
  app.post('/v1/auth/sessions',async(req,reply)=>{const x=body(z.object({token:z.string().min(8)}),req.body);const created=await auth.createSession(x.token);writeSessionCookie(reply,created.session_token,SESSION_MAX_AGE,cookieSecure);return auth.identity(created.user_id)});
  app.delete('/v1/auth/sessions/current',async(req,reply)=>{const result=await auth.revokeSession(readSessionCookie(req));writeSessionCookie(reply,'',0,cookieSecure);return result});
  app.get('/v1/auth/me',async req=>{const session=await auth.resolveSession(readSessionCookie(req));return auth.identity(session.userId)});
  // Developer beta: no email transport, so an authorized company member mints a link and
  // reads it once from this response. Delivery stays behind the SignInLinkDelivery seam.
  app.post('/v1/companies/:companyId/users/:userId/sign-in-links',async req=>{const p=body(z.object({companyId:z.string().uuid(),userId:z.string().uuid()}),req.params);const session=await auth.resolveSession(readSessionCookie(req));return auth.issueSignInLinkFor({companyId:p.companyId,actorUserId:session.userId,userId:p.userId})});
  app.post('/v1/companies',async req=>{const x=body(z.object({name:z.string().min(1)}),req.body);return service.createCompany(x.name)});
  app.post('/v1/companies/:companyId/humans',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({email:z.string().email(),display_name:z.string().min(1)}),req.body);return service.createHuman(p.companyId,x.email,x.display_name)});
  app.post('/v1/companies/:companyId/agents',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({owner_user_id:z.string().uuid(),name:z.string().min(1)}),req.body);return service.createAgent(p.companyId,x.owner_user_id,x.name)});
  app.post('/v1/companies/:companyId/projects',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1),objective:z.string().min(1)}),req.body);return service.createProject(p.companyId,await principal(req,p.companyId),x.name,x.objective)});
  app.post('/v1/companies/:companyId/projects/:projectId/rooms',async req=>{const p=body(z.object({companyId:z.string().uuid(),projectId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1),responsibilities:z.string().default('Manage the project room')}),req.body);return service.createRoom(p.companyId,p.projectId,await principal(req,p.companyId),x.name,x.responsibilities)});
  app.post('/v1/companies/:companyId/rooms/:roomId/members',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({principal_id:z.string().uuid(),role:z.enum(['manager','contributor','worker_agent']),responsibilities:z.string().default('')}),req.body);return service.addMember({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),principalId:x.principal_id,role:x.role,responsibilities:x.responsibilities,idempotencyKey:idem(req)})});
  app.delete('/v1/companies/:companyId/rooms/:roomId/members/:principalId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),principalId:z.string().uuid()}),req.params);return service.removeMember({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),principalId:p.principalId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/messages',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({body:z.string().min(1),addressed_principal_id:z.string().uuid().optional(),task_id:z.string().uuid().optional()}),req.body);return service.sendMessage({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),addressedPrincipalId:x.addressed_principal_id,body:x.body,taskId:x.task_id,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/tasks',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({title:z.string().min(1),description:z.string().default(''),assignee_principal_id:z.string().uuid().optional()}),req.body);return service.createTask({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),title:x.title,description:x.description,assigneePrincipalId:x.assignee_principal_id,idempotencyKey:idem(req)})});
  app.patch('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/status',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid()}),req.params);const x=body(z.object({status:z.enum(['open','in_progress','blocked','awaiting_decision','completed','cancelled']),expected_version:z.number().int().positive()}),req.body);return service.updateTaskStatus({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),taskId:p.taskId,status:x.status,expectedVersion:x.expected_version,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({agent_principal_id:z.string().uuid(),task_id:z.string().uuid().optional(),script:z.array(fakeStep).min(1),max_attempts:z.number().int().min(1).max(10).default(3)}),req.body);return agentRuntime.queueRun({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),agentPrincipalId:x.agent_principal_id,taskId:x.task_id,script:x.script,maxAttempts:x.max_attempts,idempotencyKey:idem(req)})});
  app.get('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);await service.snapshot(p.companyId,p.roomId,await principal(req,p.companyId));const run=await agentRuntime.getRun(p.runId);if(run.company_id!==p.companyId||run.room_id!==p.roomId)throw new DomainError('run_not_found','Agent run not found',404);return run});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId/cancel',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);return agentRuntime.cancelRun({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),runId:p.runId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId/decisions',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);const x=body(z.object({lease_token:z.string().uuid(),step_id:z.string().min(1),title:z.string().min(1),question:z.string().min(1),rationale:z.string().default(''),proposed_action:z.record(z.string(),z.unknown()),expires_at:z.string().datetime({offset:true}).optional()}),req.body);const run=await agentRuntime.getRun(p.runId);if(run.company_id!==p.companyId||run.room_id!==p.roomId)throw new DomainError('run_not_found','Agent run not found',404);if(run.agent_principal_id!==await principal(req,p.companyId))throw new DomainError('permission_denied','Only the running agent may request its decision',403);return agentRuntime.requestDecision({...run,lease_token:x.lease_token,lease_owner:run.lease_owner??'http-tool'} as any,{kind:'tool',id:x.step_id,name:'decision.request',arguments:{title:x.title,question:x.question,rationale:x.rationale,proposed_action:x.proposed_action,...(x.expires_at?{expires_at:x.expires_at}:{})}})});
  app.get('/v1/companies/:companyId/rooms/:roomId/decisions',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const q=body(z.object({status:z.enum(['pending','approved','rejected','cancelled','expired']).optional()}),req.query);return agentRuntime.listDecisions({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),status:q.status})});
  app.get('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);return agentRuntime.getDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId})});
  const resolutionBody=z.object({proposed_action_digest:z.string().regex(/^[0-9a-f]{64}$/),expected_version:z.number().int().positive(),note:z.string().max(4000).optional()});
  app.post('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId/approve',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);const x=body(resolutionBody,req.body);return agentRuntime.resolveDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId,resolution:'approved',proposedActionDigest:x.proposed_action_digest,expectedVersion:x.expected_version,note:x.note,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId/reject',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);const x=body(resolutionBody,req.body);return agentRuntime.resolveDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId,resolution:'rejected',proposedActionDigest:x.proposed_action_digest,expectedVersion:x.expected_version,note:x.note,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/decisions/:decisionId/cancel',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),decisionId:z.string().uuid()}),req.params);const x=body(z.object({expected_version:z.number().int().positive()}),req.body);return agentRuntime.cancelDecision({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),decisionId:p.decisionId,expectedVersion:x.expected_version,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agents/:agentId/pause',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),agentId:z.string().uuid()}),req.params);return agentRuntime.pauseAgent({companyId:p.companyId,roomId:p.roomId,actorId:await principal(req,p.companyId),agentId:p.agentId,idempotencyKey:idem(req)})});
  app.get('/v1/companies/:companyId/rooms/:roomId/snapshot',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);return service.snapshot(p.companyId,p.roomId,await principal(req,p.companyId))});
  app.get('/v1/companies/:companyId/rooms/:roomId/events',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const q=body(z.object({after_seq:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().positive().max(500).default(100)}),req.query);return service.events(p.companyId,p.roomId,await principal(req,p.companyId),q.after_seq,q.limit)});
  registerAgentGatewayRoutes(app,agentGateway,service,agentRuntime,realtime);
  app.register(async realtimeRoutes=>{
    realtimeRoutes.get('/v1/companies/:companyId/rooms/:roomId/stream',{websocket:true},(socket,req)=>{
      void (async()=>{ try {
        const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);
        const q=body(z.object({after_seq:z.coerce.number().int().min(0).optional(),principal_id:z.string().uuid().optional()}),req.query);
        let principalId:string|undefined;
        if(allowHeaderPrincipal){ const header=req.headers['x-principal-id']; principalId=typeof header==='string'?header:q.principal_id; }
        if(!principalId){ const session=await auth.resolveSession(readSessionCookie(req)); principalId=await auth.principalFor(session.userId,p.companyId); }
        await realtime.attach(socket,{companyId:p.companyId,roomId:p.roomId,principalId,afterSeq:q.after_seq});
      } catch(error) {
        const domain=error instanceof DomainError?error:new DomainError('validation_error','Invalid realtime subscription',400);
        socket.send(JSON.stringify({type:'protocol_error',code:domain.code,message:domain.message}));
        socket.close(domain.statusCode===401?4401:4400,'subscription_rejected');
      } })();
    });
  });
  const webRoot=resolve(process.cwd(),'dist/web');
  if(existsSync(webRoot)){
    app.register(fastifyStatic,{root:webRoot,wildcard:false});
    app.get('/rooms/*',async(_request,reply)=>reply.sendFile('index.html'));
  }
  app.addHook('onReady',async()=>{await realtime.start()});
  app.addHook('onClose',async()=>{await realtime.stop();await pool.end()});
  return app;
}
