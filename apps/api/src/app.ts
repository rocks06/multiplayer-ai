import Fastify from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { DomainError } from "../../../packages/domain/src/index.js";
import { createPool, type DbPool } from "./db.js";
import { RoomService } from "./room-service.js";
import { RealtimeHub, type RealtimeOptions } from "./realtime/realtime-hub.js";
import { AgentRuntimeService } from "./agent-runtime/runtime-service.js";

const fakeStep=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('tool'),id:z.string().min(1),name:z.enum(['room.send_message','task.get','task.list_eligible','task.update_status','task.complete']),arguments:z.record(z.string(),z.unknown())}),
  z.object({kind:z.literal('barrier'),id:z.string().min(1),name:z.string().min(1)}),
  z.object({kind:z.literal('expect_message'),id:z.string().min(1),includes:z.string(),sender_principal_id:z.string().uuid().optional()}),
  z.object({kind:z.literal('transient_failure'),id:z.string().min(1),times:z.number().int().min(0)}),
  z.object({kind:z.literal('permanent_failure'),id:z.string().min(1),message:z.string()}),
  z.object({kind:z.literal('complete'),id:z.string().min(1)})
]);

const body = <T extends z.ZodTypeAny>(schema:T, value:unknown):z.infer<T> => schema.parse(value);
const principal = (request:any) => { const id=request.headers["x-principal-id"]; if(typeof id!=="string") throw new DomainError("unauthenticated","x-principal-id is required for Phase 1A local/dev authentication",401); return id; };
const idem = (request:any) => { const key=request.headers["idempotency-key"]; if(typeof key!=="string") throw new DomainError("idempotency_key_required","Idempotency-Key is required",400); return key; };

export function buildApp(pool:DbPool=createPool(), realtimeOptions:RealtimeOptions={}) {
  const app=Fastify({logger:false});
  const service=new RoomService(pool);
  const agentRuntime=new AgentRuntimeService(pool,service);
  const realtime=new RealtimeHub(pool,service,realtimeOptions);
  app.register(websocket);
  app.setErrorHandler((error,request,reply)=>{ if(error instanceof DomainError) return reply.status(error.statusCode).send({error:{code:error.code,message:error.message,request_id:request.id,details:error.details}}); if(error instanceof z.ZodError) return reply.status(400).send({error:{code:"validation_error",message:"Invalid request",request_id:request.id,details:error.issues}}); request.log.error(error); return reply.status(500).send({error:{code:"internal_error",message:"Internal server error",request_id:request.id}}); });
  app.get('/health',async()=>({status:'ok'}));
  app.post('/v1/companies',async req=>{const x=body(z.object({name:z.string().min(1)}),req.body);return service.createCompany(x.name)});
  app.post('/v1/companies/:companyId/humans',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({email:z.string().email(),display_name:z.string().min(1)}),req.body);return service.createHuman(p.companyId,x.email,x.display_name)});
  app.post('/v1/companies/:companyId/agents',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({owner_user_id:z.string().uuid(),name:z.string().min(1)}),req.body);return service.createAgent(p.companyId,x.owner_user_id,x.name)});
  app.post('/v1/companies/:companyId/projects',async req=>{const p=body(z.object({companyId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1),objective:z.string().min(1)}),req.body);return service.createProject(p.companyId,principal(req),x.name,x.objective)});
  app.post('/v1/companies/:companyId/projects/:projectId/rooms',async req=>{const p=body(z.object({companyId:z.string().uuid(),projectId:z.string().uuid()}),req.params);const x=body(z.object({name:z.string().min(1),responsibilities:z.string().default('Manage the project room')}),req.body);return service.createRoom(p.companyId,p.projectId,principal(req),x.name,x.responsibilities)});
  app.post('/v1/companies/:companyId/rooms/:roomId/members',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({principal_id:z.string().uuid(),role:z.enum(['manager','contributor','worker_agent']),responsibilities:z.string().default('')}),req.body);return service.addMember({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),principalId:x.principal_id,role:x.role,responsibilities:x.responsibilities,idempotencyKey:idem(req)})});
  app.delete('/v1/companies/:companyId/rooms/:roomId/members/:principalId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),principalId:z.string().uuid()}),req.params);return service.removeMember({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),principalId:p.principalId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/messages',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({body:z.string().min(1),addressed_principal_id:z.string().uuid().optional(),task_id:z.string().uuid().optional()}),req.body);return service.sendMessage({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),addressedPrincipalId:x.addressed_principal_id,body:x.body,taskId:x.task_id,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/tasks',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({title:z.string().min(1),description:z.string().default(''),assignee_principal_id:z.string().uuid().optional()}),req.body);return service.createTask({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),title:x.title,description:x.description,assigneePrincipalId:x.assignee_principal_id,idempotencyKey:idem(req)})});
  app.patch('/v1/companies/:companyId/rooms/:roomId/tasks/:taskId/status',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),taskId:z.string().uuid()}),req.params);const x=body(z.object({status:z.enum(['open','in_progress','blocked','awaiting_decision','completed','cancelled']),expected_version:z.number().int().positive()}),req.body);return service.updateTaskStatus({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),taskId:p.taskId,status:x.status,expectedVersion:x.expected_version,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const x=body(z.object({agent_principal_id:z.string().uuid(),task_id:z.string().uuid().optional(),script:z.array(fakeStep).min(1),max_attempts:z.number().int().min(1).max(10).default(3)}),req.body);return agentRuntime.queueRun({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),agentPrincipalId:x.agent_principal_id,taskId:x.task_id,script:x.script,maxAttempts:x.max_attempts,idempotencyKey:idem(req)})});
  app.get('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);await service.snapshot(p.companyId,p.roomId,principal(req));const run=await agentRuntime.getRun(p.runId);if(run.company_id!==p.companyId||run.room_id!==p.roomId)throw new DomainError('run_not_found','Agent run not found',404);return run});
  app.post('/v1/companies/:companyId/rooms/:roomId/agent-runs/:runId/cancel',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),runId:z.string().uuid()}),req.params);return agentRuntime.cancelRun({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),runId:p.runId,idempotencyKey:idem(req)})});
  app.post('/v1/companies/:companyId/rooms/:roomId/agents/:agentId/pause',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid(),agentId:z.string().uuid()}),req.params);return agentRuntime.pauseAgent({companyId:p.companyId,roomId:p.roomId,actorId:principal(req),agentId:p.agentId,idempotencyKey:idem(req)})});
  app.get('/v1/companies/:companyId/rooms/:roomId/snapshot',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);return service.snapshot(p.companyId,p.roomId,principal(req))});
  app.get('/v1/companies/:companyId/rooms/:roomId/events',async req=>{const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);const q=body(z.object({after_seq:z.coerce.number().int().min(0).default(0),limit:z.coerce.number().int().positive().max(500).default(100)}),req.query);return service.events(p.companyId,p.roomId,principal(req),q.after_seq,q.limit)});
  app.register(async realtimeRoutes=>{
    realtimeRoutes.get('/v1/companies/:companyId/rooms/:roomId/stream',{websocket:true},(socket,req)=>{
      try {
        const p=body(z.object({companyId:z.string().uuid(),roomId:z.string().uuid()}),req.params);
        const q=body(z.object({after_seq:z.coerce.number().int().min(0).optional(),principal_id:z.string().uuid().optional()}),req.query);
        const headerPrincipal=req.headers['x-principal-id'];
        const principalId=typeof headerPrincipal==='string'?headerPrincipal:q.principal_id;
        if(!principalId) throw new DomainError('unauthenticated','x-principal-id header or principal_id query parameter is required',401);
        void realtime.attach(socket,{companyId:p.companyId,roomId:p.roomId,principalId,afterSeq:q.after_seq});
      } catch(error) {
        const domain=error instanceof DomainError?error:new DomainError('validation_error','Invalid realtime subscription',400);
        socket.send(JSON.stringify({type:'protocol_error',code:domain.code,message:domain.message}));
        socket.close(domain.statusCode===401?4401:4400,'subscription_rejected');
      }
    });
  });
  app.addHook('onReady',async()=>{await realtime.start()});
  app.addHook('onClose',async()=>{await realtime.stop();await pool.end()});
  return app;
}
