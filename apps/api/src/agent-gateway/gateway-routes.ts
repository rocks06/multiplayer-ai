import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { DomainError } from "../../../../packages/domain/src/index.js";
import type { RoomService } from "../room-service.js";
import type { AgentRuntimeService } from "../agent-runtime/runtime-service.js";
import type { RealtimeHub } from "../realtime/realtime-hub.js";
import { AgentGatewayService } from "./gateway-service.js";

const parse=<T extends z.ZodTypeAny>(schema:T,value:unknown):z.infer<T>=>schema.parse(value);
const authorization=(req:any)=>req.headers.authorization;
const idempotency=(req:any)=>{const key=req.headers["idempotency-key"];if(typeof key!=="string"||!key)throw new DomainError("idempotency_key_required","Idempotency-Key is required",400);return key};
const sessionParams=z.object({sessionId:z.string().uuid()});
const taskStatuses=z.enum(["open","in_progress","blocked","awaiting_decision","completed","cancelled"]);

export function registerAgentGatewayRoutes(app:FastifyInstance,gateway:AgentGatewayService,rooms:RoomService,runtime:AgentRuntimeService,realtime:RealtimeHub) {
  app.post("/v1/companies/:companyId/agents/:agentPrincipalId/gateway-credentials",async req=>{
    const p=parse(z.object({companyId:z.string().uuid(),agentPrincipalId:z.string().uuid()}),req.params);
    const x=parse(z.object({label:z.string().min(1).max(100)}),req.body);
    const actor=req.headers["x-principal-id"];if(typeof actor!=="string")throw new DomainError("unauthenticated","x-principal-id is required",401);
    return gateway.createCredential({companyId:p.companyId,actorId:actor,agentPrincipalId:p.agentPrincipalId,label:x.label});
  });
  app.delete("/v1/companies/:companyId/gateway-credentials/:credentialId",async req=>{
    const p=parse(z.object({companyId:z.string().uuid(),credentialId:z.string().uuid()}),req.params);
    const actor=req.headers["x-principal-id"];if(typeof actor!=="string")throw new DomainError("unauthenticated","x-principal-id is required",401);
    return gateway.revokeCredential({companyId:p.companyId,actorId:actor,credentialId:p.credentialId});
  });

  app.get("/v1/agent-gateway/v1/rooms",req=>gateway.listRooms(authorization(req)));
  app.post("/v1/agent-gateway/v1/sessions",async req=>{
    const x=parse(z.object({room_id:z.string().uuid(),runtime_status:z.enum(["idle","working"]).default("idle")}),req.body);
    return gateway.openSession(authorization(req),x.room_id,x.runtime_status);
  });

  const session=async(req:any)=>{const p=parse(sessionParams,req.params);return gateway.authenticateSession(p.sessionId,authorization(req))};
  app.get("/v1/agent-gateway/v1/sessions/:sessionId/snapshot",async req=>{const s=await session(req);return rooms.snapshot(s.companyId,s.roomId,s.principalId)});
  app.get("/v1/agent-gateway/v1/sessions/:sessionId/tasks",async req=>{const s=await session(req);return rooms.listEligibleTasks({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId})});
  app.get("/v1/agent-gateway/v1/sessions/:sessionId/tasks/:taskId",async req=>{const p=parse(sessionParams.extend({taskId:z.string().uuid()}),req.params);const s=await gateway.authenticateSession(p.sessionId,authorization(req));return rooms.getTask({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId,taskId:p.taskId})});
  app.post("/v1/agent-gateway/v1/sessions/:sessionId/messages",async req=>{
    const s=await session(req);const x=parse(z.object({body:z.string().min(1),addressed_principal_id:z.string().uuid().optional(),task_id:z.string().uuid().optional()}),req.body);
    return rooms.sendMessage({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId,body:x.body,addressedPrincipalId:x.addressed_principal_id,taskId:x.task_id,idempotencyKey:idempotency(req)});
  });
  app.patch("/v1/agent-gateway/v1/sessions/:sessionId/tasks/:taskId/status",async req=>{
    const p=parse(sessionParams.extend({taskId:z.string().uuid()}),req.params);const s=await gateway.authenticateSession(p.sessionId,authorization(req));const x=parse(z.object({status:taskStatuses,expected_version:z.number().int().positive()}),req.body);
    return rooms.updateTaskStatus({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId,taskId:p.taskId,status:x.status,expectedVersion:x.expected_version,idempotencyKey:idempotency(req)});
  });
  app.post("/v1/agent-gateway/v1/sessions/:sessionId/tasks/:taskId/complete",async req=>{
    const p=parse(sessionParams.extend({taskId:z.string().uuid()}),req.params);const s=await gateway.authenticateSession(p.sessionId,authorization(req));const x=parse(z.object({expected_version:z.number().int().positive()}),req.body);
    return rooms.updateTaskStatus({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId,taskId:p.taskId,status:"completed",expectedVersion:x.expected_version,idempotencyKey:idempotency(req)});
  });
  app.post("/v1/agent-gateway/v1/sessions/:sessionId/decisions",async req=>{
    const s=await session(req);const x=parse(z.object({title:z.string().min(1),question:z.string().min(1),rationale:z.string().default(""),proposed_action:z.record(z.string(),z.unknown()),expires_at:z.string().datetime({offset:true}).optional()}),req.body);
    return runtime.requestExternalDecision({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId,title:x.title,question:x.question,rationale:x.rationale,proposedAction:x.proposed_action,expiresAt:x.expires_at,idempotencyKey:idempotency(req)});
  });
  app.get("/v1/agent-gateway/v1/sessions/:sessionId/decisions/:decisionId",async req=>{const p=parse(sessionParams.extend({decisionId:z.string().uuid()}),req.params);const s=await gateway.authenticateSession(p.sessionId,authorization(req));return runtime.getDecision({companyId:s.companyId,roomId:s.roomId,actorId:s.principalId,decisionId:p.decisionId})});
  app.post("/v1/agent-gateway/v1/sessions/:sessionId/heartbeat",async req=>{const p=parse(sessionParams,req.params);const x=parse(z.object({runtime_status:z.enum(["idle","working"])}),req.body);return gateway.heartbeat(p.sessionId,authorization(req),x.runtime_status)});
  app.post("/v1/agent-gateway/v1/sessions/:sessionId/disconnect",async req=>{const p=parse(sessionParams,req.params);return gateway.disconnect(p.sessionId,authorization(req))});

  app.register(async routes=>{
    routes.get("/v1/agent-gateway/v1/sessions/:sessionId/stream",{websocket:true},(socket,req)=>{
      void (async()=>{try{
        const p=parse(sessionParams,req.params);const q=parse(z.object({after_seq:z.coerce.number().int().min(0).optional()}),req.query);const auth=authorization(req);
        const s=await gateway.resumeSession(p.sessionId,auth);const afterSeq=q.after_seq;
        await realtime.attach(socket,{companyId:s.companyId,roomId:s.roomId,principalId:s.principalId,afterSeq,protocol:"agent-gateway.v1",gatewaySessionId:s.sessionId,validate:async()=>{await gateway.authenticateSession(p.sessionId,auth)},onAck:seq=>gateway.acknowledge(p.sessionId,auth,seq),onDisconnect:async()=>{try{await gateway.disconnect(p.sessionId,auth)}catch{}}});
      }catch(error){const e=error instanceof DomainError?error:new DomainError("validation_error","Invalid gateway subscription",400);socket.send(JSON.stringify({type:"protocol_error",code:e.code,message:e.message}));socket.close(e.statusCode===401?4401:4403,"subscription_rejected")}})();
    });
  });
}
