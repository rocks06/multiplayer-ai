import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { DbClient, DbPool } from "./db.js";
import { canTransitionTask, DomainError, roleHasPermission, type Permission, type RoomRole, type TaskStatus } from "../../../packages/domain/src/index.js";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : canonical(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter(([,item])=>item!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,canonical(item)]));
  return value;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

interface Actor { id: string; company_id: string; kind: "human"|"agent"|"system"; display_name: string; }
interface Membership { role: RoomRole; responsibilities: string; }
export interface RunGuard { runId:string; runGeneration:number; leaseToken:string; }
interface CommandContext { companyId: string; roomId: string; actorId: string; idempotencyKey: string; commandType: string; input: unknown; permission: Permission; runGuard?:RunGuard; }

export class RoomService {
  constructor(private readonly pool: DbPool) {}

  private async actor(client: DbClient, companyId: string, actorId: string): Promise<Actor> {
    const result = await client.query<Actor>(`SELECT p.id,p.company_id,p.kind,p.display_name FROM principals p LEFT JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.id=$1 AND p.company_id=$2 AND p.status='active' AND (p.kind<>'agent' OR a.status='active')`, [actorId, companyId]);
    if (!result.rowCount) throw new DomainError("forbidden", "Principal is not active in this company", 403);
    return result.rows[0]!;
  }

  private async membership(client: DbClient, companyId: string, roomId: string, actorId: string): Promise<Membership> {
    const result = await client.query<Membership>(`SELECT role, responsibilities FROM room_members WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active' FOR SHARE`, [companyId, roomId, actorId]);
    if (!result.rowCount) throw new DomainError("room_access_denied", "Active room membership is required", 403);
    return result.rows[0]!;
  }

  private async authorize(client: DbClient, companyId: string, roomId: string, actorId: string, permission: Permission) {
    const member = await this.membership(client, companyId, roomId, actorId);
    if (!roleHasPermission(member.role, permission)) throw new DomainError("permission_denied", `Missing permission: ${permission}`, 403);
    return member;
  }

  private async assertRunGuard(client:DbClient,companyId:string,roomId:string,actorId:string,guard:RunGuard){
    const valid=await client.query(`SELECT 1 FROM agent_runs ar JOIN agents a ON a.company_id=ar.company_id AND a.id=ar.agent_id JOIN principals p ON p.company_id=ar.company_id AND p.id=ar.agent_principal_id AND p.agent_id=ar.agent_id JOIN room_members rm ON rm.company_id=ar.company_id AND rm.room_id=ar.room_id AND rm.principal_id=ar.agent_principal_id WHERE ar.id=$1 AND ar.company_id=$2 AND ar.room_id=$3 AND ar.agent_principal_id=$4 AND ar.run_generation=$5 AND ar.lease_token=$6 AND ar.status='running' AND ar.lease_expires_at>now() AND a.status='active' AND a.run_generation=ar.run_generation AND p.status='active' AND rm.status='active' FOR UPDATE OF ar,a,rm`,[guard.runId,companyId,roomId,actorId,guard.runGeneration,guard.leaseToken]);
    if(!valid.rowCount)throw new DomainError('stale_agent_run','Agent run lease, generation, status, or membership is no longer valid',409);
  }

  private async appendEvent(client: DbClient, args: {companyId:string; roomId:string; actor:Actor; eventType:string; entityType:string; entityId:string; entityVersion?:number; payload:unknown; commandId:string; correlationId:string;}) {
    const seqResult = await client.query<{last_event_seq:string}>(`UPDATE rooms SET last_event_seq=last_event_seq+1 WHERE id=$1 AND company_id=$2 RETURNING last_event_seq`, [args.roomId, args.companyId]);
    if (!seqResult.rowCount) throw new DomainError("room_not_found", "Room not found", 404);
    const roomSeq = Number(seqResult.rows[0]!.last_event_seq);
    const eventId = uuidv7();
    await client.query(`INSERT INTO room_events (id,company_id,room_id,room_seq,event_type,actor_principal_id,actor_kind,actor_display_name,entity_type,entity_id,entity_version,payload,command_id,correlation_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [eventId,args.companyId,args.roomId,roomSeq,args.eventType,args.actor.id,args.actor.kind,args.actor.display_name,args.entityType,args.entityId,args.entityVersion??null,JSON.stringify(args.payload),args.commandId,args.correlationId]);
    // PostgreSQL is authoritative; NOTIFY only wakes realtime gateways after commit.
    await client.query(`SELECT pg_notify('room_events', $1)`, [JSON.stringify({company_id:args.companyId,room_id:args.roomId,room_seq:roomSeq})]);
    return { eventId, roomSeq };
  }

  private async command<T>(ctx: CommandContext, run: (client:DbClient, actor:Actor, commandId:string)=>Promise<{response:T; event:{type:string; entityType:string; entityId:string; entityVersion?:number; payload:unknown}}>): Promise<T & {event_id:string; room_seq:number; command_id:string}> {
    if (!ctx.idempotencyKey) throw new DomainError("idempotency_key_required", "Idempotency-Key is required", 400);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const actor = await this.actor(client, ctx.companyId, ctx.actorId);
      await this.authorize(client, ctx.companyId, ctx.roomId, ctx.actorId, ctx.permission);
      if(ctx.runGuard)await this.assertRunGuard(client,ctx.companyId,ctx.roomId,ctx.actorId,ctx.runGuard);
      const requestDigest = digest({protocol_version:1,company_id:ctx.companyId,room_id:ctx.roomId,principal_id:ctx.actorId,command_type:ctx.commandType,input:ctx.input});
      const commandId = uuidv7();
      const inserted = await client.query(`INSERT INTO command_receipts (command_id,company_id,room_id,principal_id,idempotency_key,command_type,request_digest,response_status,response_body) VALUES ($1,$2,$3,$4,$5,$6,$7,0,'{}'::jsonb) ON CONFLICT (company_id,room_id,principal_id,command_type,idempotency_key) DO NOTHING RETURNING command_id`, [commandId,ctx.companyId,ctx.roomId,ctx.actorId,ctx.idempotencyKey,ctx.commandType,requestDigest]);
      if (!inserted.rowCount) {
        const prior = await client.query<{command_id:string;request_digest:string;response_body:T & {event_id:string;room_seq:number;command_id:string}}>(`SELECT command_id,request_digest,response_body FROM command_receipts WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND command_type=$4 AND idempotency_key=$5`, [ctx.companyId,ctx.roomId,ctx.actorId,ctx.commandType,ctx.idempotencyKey]);
        const receipt = prior.rows[0]!;
        if (receipt.request_digest !== requestDigest) throw new DomainError("idempotency_key_reused", "Idempotency key was used with different input", 409);
        await client.query("COMMIT");
        return receipt.response_body;
      }
      const result = await run(client, actor, commandId);
      const event = await this.appendEvent(client, {companyId:ctx.companyId, roomId:ctx.roomId, actor, eventType:result.event.type, entityType:result.event.entityType, entityId:result.event.entityId, entityVersion:result.event.entityVersion, payload:result.event.payload, commandId, correlationId:commandId});
      const response = {...result.response, event_id:event.eventId, room_seq:event.roomSeq, command_id:commandId};
      await client.query(`UPDATE command_receipts SET response_status=200,response_body=$2 WHERE command_id=$1`, [commandId,JSON.stringify(response)]);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async createCompany(name:string) { const id=uuidv7(); await this.pool.query(`INSERT INTO companies(id,name) VALUES($1,$2)`,[id,name]); return {id,name}; }
  async createHuman(companyId:string,email:string,displayName:string) { const userId=uuidv7(), principalId=uuidv7(); const c=await this.pool.connect(); try { await c.query('BEGIN'); await c.query(`INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)`,[userId,email,displayName]); await c.query(`INSERT INTO company_users(company_id,user_id) VALUES($1,$2)`,[companyId,userId]); await c.query(`INSERT INTO principals(id,company_id,kind,user_id,display_name) VALUES($1,$2,'human',$3,$4)`,[principalId,companyId,userId,displayName]); await c.query('COMMIT'); return {user_id:userId,principal_id:principalId}; } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();} }
  async createAgent(companyId:string,ownerUserId:string,name:string) { const agentId=uuidv7(), principalId=uuidv7(); const c=await this.pool.connect(); try { await c.query('BEGIN'); await c.query(`INSERT INTO agents(id,company_id,owner_user_id,name) VALUES($1,$2,$3,$4)`,[agentId,companyId,ownerUserId,name]); await c.query(`INSERT INTO principals(id,company_id,kind,agent_id,display_name) VALUES($1,$2,'agent',$3,$4)`,[principalId,companyId,agentId,name]); await c.query('COMMIT'); return {agent_id:agentId,principal_id:principalId}; } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();} }
  async createProject(companyId:string,actorId:string,name:string,objective:string) { await this.pool.query(`SELECT 1 FROM principals WHERE id=$1 AND company_id=$2`,[actorId,companyId]).then(r=>{if(!r.rowCount)throw new DomainError('forbidden','Invalid company principal',403)}); const id=uuidv7(); await this.pool.query(`INSERT INTO projects(id,company_id,name,objective,created_by_principal_id) VALUES($1,$2,$3,$4,$5)`,[id,companyId,name,objective,actorId]); return {id,name,objective}; }
  async createRoom(companyId:string,projectId:string,actorId:string,name:string,responsibilities:string) { const c=await this.pool.connect(); try { await c.query('BEGIN'); const actor=await this.actor(c,companyId,actorId); const roomId=uuidv7(), memberId=uuidv7(), commandId=uuidv7(); await c.query(`INSERT INTO rooms(id,company_id,project_id,name,created_by_principal_id) VALUES($1,$2,$3,$4,$5)`,[roomId,companyId,projectId,name,actorId]); await c.query(`INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities) VALUES($1,$2,$3,$4,'manager',$5)`,[memberId,companyId,roomId,actorId,responsibilities]); await this.appendEvent(c,{companyId,roomId,actor,eventType:'room.created',entityType:'room',entityId:roomId,payload:{name},commandId,correlationId:commandId}); await this.appendEvent(c,{companyId,roomId,actor,eventType:'member.joined',entityType:'room_member',entityId:memberId,payload:{principal_id:actorId,role:'manager'},commandId,correlationId:commandId}); await c.query('COMMIT'); return {id:roomId,name,room_seq:2}; } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();} }

  async addMember(input:{companyId:string;roomId:string;actorId:string;principalId:string;role:RoomRole;responsibilities:string;idempotencyKey:string}) { return this.command({...input,commandType:'member.add',input:{principalId:input.principalId,role:input.role,responsibilities:input.responsibilities},permission:'member.manage'}, async(c)=>{ const target=await this.actor(c,input.companyId,input.principalId); const id=uuidv7(); await c.query(`INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities) VALUES($1,$2,$3,$4,$5,$6)`,[id,input.companyId,input.roomId,input.principalId,input.role,input.responsibilities]); return {response:{id,principal_id:target.id,role:input.role},event:{type:'member.joined',entityType:'room_member',entityId:id,payload:{principal_id:target.id,role:input.role}}}; }); }

  async removeMember(input:{companyId:string;roomId:string;actorId:string;principalId:string;idempotencyKey:string}) {
    return this.command({...input,commandType:'member.remove',input:{principalId:input.principalId},permission:'member.manage'}, async(c)=>{
      const removed=await c.query<{id:string}>(`UPDATE room_members SET status='removed',removed_at=now() WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active' RETURNING id`,[input.companyId,input.roomId,input.principalId]);
      if(!removed.rowCount) throw new DomainError('member_not_found','Active room member not found',404);
      const id=removed.rows[0]!.id;
      return {response:{id,principal_id:input.principalId,status:'removed'},event:{type:'member.removed',entityType:'room_member',entityId:id,payload:{principal_id:input.principalId,status:'removed'}}};
    });
  }

  async roomCursor(companyId:string,roomId:string,actorId:string) {
    const result=await this.pool.query<{last_event_seq:string}>(`SELECT r.last_event_seq FROM rooms r JOIN principals p ON p.company_id=r.company_id AND p.id=$3 AND p.status='active' JOIN room_members rm ON rm.company_id=r.company_id AND rm.room_id=r.id AND rm.principal_id=p.id AND rm.status='active' WHERE r.company_id=$1 AND r.id=$2`,[companyId,roomId,actorId]);
    if(!result.rowCount) throw new DomainError('room_access_denied','Active room membership is required',403);
    return Number(result.rows[0]!.last_event_seq);
  }

  async sendMessage(input:{companyId:string;roomId:string;actorId:string;addressedPrincipalId?:string;body:string;taskId?:string;idempotencyKey:string;runGuard?:RunGuard}) { return this.command({...input,commandType:'message.send',input:{addressedPrincipalId:input.addressedPrincipalId,body:input.body,taskId:input.taskId},permission:'message.send'}, async(c)=>{ if(input.addressedPrincipalId) await this.membership(c,input.companyId,input.roomId,input.addressedPrincipalId); const id=uuidv7(); await c.query(`INSERT INTO messages(id,company_id,room_id,sender_principal_id,addressed_principal_id,body_text,task_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,input.companyId,input.roomId,input.actorId,input.addressedPrincipalId??null,input.body,input.taskId??null]); const response={id,body_text:input.body,addressed_principal_id:input.addressedPrincipalId??null}; return {response,event:{type:'message.sent',entityType:'message',entityId:id,payload:response}}; }); }

  async createTask(input:{companyId:string;roomId:string;actorId:string;title:string;description:string;assigneePrincipalId?:string;idempotencyKey:string}) { return this.command({...input,commandType:'task.create',input:{title:input.title,description:input.description,assigneePrincipalId:input.assigneePrincipalId},permission:'task.create'}, async(c)=>{ if(input.assigneePrincipalId) await this.membership(c,input.companyId,input.roomId,input.assigneePrincipalId); const id=uuidv7(); await c.query(`INSERT INTO tasks(id,company_id,room_id,title,description,created_by_principal_id,assignee_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,input.companyId,input.roomId,input.title,input.description,input.actorId,input.assigneePrincipalId??null]); const response={id,title:input.title,status:'open' as TaskStatus,version:1,assignee_principal_id:input.assigneePrincipalId??null}; return {response,event:{type:'task.created',entityType:'task',entityId:id,entityVersion:1,payload:response}}; }); }

  async updateTaskStatus(input:{companyId:string;roomId:string;actorId:string;taskId:string;status:TaskStatus;expectedVersion:number;idempotencyKey:string;runGuard?:RunGuard}) { const client=await this.pool.connect(); let permission:Permission='task.update.own'; try { await client.query('BEGIN');const m=await this.membership(client,input.companyId,input.roomId,input.actorId); if(roleHasPermission(m.role,'task.update.any')) permission='task.update.any';await client.query('COMMIT'); } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();} return this.command({...input,commandType:'task.status.update',input:{taskId:input.taskId,status:input.status,expectedVersion:input.expectedVersion},permission}, async(c)=>{ const current=await c.query<{status:TaskStatus;version:number;assignee_principal_id:string|null}>(`SELECT status,version,assignee_principal_id FROM tasks WHERE id=$1 AND company_id=$2 AND room_id=$3 FOR UPDATE`,[input.taskId,input.companyId,input.roomId]); if(!current.rowCount)throw new DomainError('task_not_found','Task not found',404); const task=current.rows[0]!; if(permission==='task.update.own' && task.assignee_principal_id!==input.actorId)throw new DomainError('permission_denied','Only the assignee may update this task',403); if(task.version!==input.expectedVersion)throw new DomainError('version_conflict','Task changed since it was read',409,{expected_version:input.expectedVersion,current_version:task.version}); if(!canTransitionTask(task.status,input.status))throw new DomainError('invalid_task_transition',`Cannot transition ${task.status} to ${input.status}`,422); const updated=await c.query<{version:number}>(`UPDATE tasks SET status=$1,version=version+1,updated_at=now(),completed_at=CASE WHEN $1='completed' THEN now() ELSE completed_at END WHERE id=$2 AND company_id=$3 AND room_id=$4 AND version=$5 RETURNING version`,[input.status,input.taskId,input.companyId,input.roomId,input.expectedVersion]);if(!updated.rowCount)throw new DomainError('version_conflict','Task changed since it was read',409,{expected_version:input.expectedVersion});const nextVersion=updated.rows[0]!.version; const response={id:input.taskId,status:input.status,version:nextVersion}; return {response,event:{type:`task.${input.status}`,entityType:'task',entityId:input.taskId,entityVersion:nextVersion,payload:response}}; }); }

  async getTask(input:{companyId:string;roomId:string;actorId:string;taskId:string;runGuard?:RunGuard}){
    const c=await this.pool.connect();try{await c.query('BEGIN');await this.actor(c,input.companyId,input.actorId);await this.authorize(c,input.companyId,input.roomId,input.actorId,'room.read');if(input.runGuard)await this.assertRunGuard(c,input.companyId,input.roomId,input.actorId,input.runGuard);const result=await c.query(`SELECT id,title,description,status,assignee_principal_id,version,updated_at FROM tasks WHERE company_id=$1 AND room_id=$2 AND id=$3`,[input.companyId,input.roomId,input.taskId]);if(!result.rowCount)throw new DomainError('task_not_found','Task not found',404);await c.query('COMMIT');return result.rows[0];}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  async listEligibleTasks(input:{companyId:string;roomId:string;actorId:string;runGuard?:RunGuard}){
    const c=await this.pool.connect();try{await c.query('BEGIN');await this.actor(c,input.companyId,input.actorId);await this.authorize(c,input.companyId,input.roomId,input.actorId,'room.read');if(input.runGuard)await this.assertRunGuard(c,input.companyId,input.roomId,input.actorId,input.runGuard);const result=await c.query(`SELECT id,title,description,status,assignee_principal_id,version,updated_at FROM tasks WHERE company_id=$1 AND room_id=$2 AND assignee_principal_id=$3 AND status IN ('open','in_progress','blocked') ORDER BY created_at`,[input.companyId,input.roomId,input.actorId]);await c.query('COMMIT');return result.rows;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
  }

  async snapshot(companyId:string,roomId:string,actorId:string) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await this.actor(c,companyId,actorId);
      const member=await this.authorize(c,companyId,roomId,actorId,'room.read');
      // A pg client executes one query at a time. Parallel request work is handled by the pool.
      const room=await c.query(`SELECT r.id,r.name,r.last_event_seq,p.id project_id,p.name project_name,p.objective FROM rooms r JOIN projects p ON p.id=r.project_id WHERE r.id=$1 AND r.company_id=$2`,[roomId,companyId]);
      if(!room.rowCount) throw new DomainError('room_not_found','Room not found',404);
      const members=await c.query(`SELECT rm.principal_id,p.display_name,p.kind,rm.role,rm.responsibilities FROM room_members rm JOIN principals p ON p.id=rm.principal_id WHERE rm.room_id=$1 AND rm.company_id=$2 AND rm.status='active' ORDER BY rm.joined_at`,[roomId,companyId]);
      const tasks=await c.query(`SELECT id,title,description,status,assignee_principal_id,version,updated_at FROM tasks WHERE room_id=$1 AND company_id=$2 ORDER BY created_at`,[roomId,companyId]);
      const messages=await c.query(`SELECT m.id,m.sender_principal_id,m.addressed_principal_id,m.body_text,m.task_id,m.created_at,p.display_name sender_name,p.kind sender_kind FROM messages m JOIN principals p ON p.id=m.sender_principal_id WHERE m.room_id=$1 AND m.company_id=$2 ORDER BY m.created_at DESC LIMIT 50`,[roomId,companyId]);
      const events=await c.query(`SELECT room_seq,event_type,actor_principal_id,actor_kind,actor_display_name,entity_type,entity_id,entity_version,payload,created_at FROM room_events WHERE room_id=$1 AND company_id=$2 ORDER BY room_seq DESC LIMIT 20`,[roomId,companyId]);
      const decisions=await c.query(`SELECT id,run_id,requested_by_principal_id,title,question,rationale,proposed_action,proposed_action_digest,status,version,resolved_by_principal_id,resolution_note,requested_at,resolved_at,expires_at FROM decisions WHERE room_id=$1 AND company_id=$2 AND status='pending' ORDER BY requested_at`,[roomId,companyId]);
      const active=tasks.rows.filter((t:any)=>!['completed','cancelled'].includes(t.status));
      const completed=tasks.rows.filter((t:any)=>t.status==='completed').slice(-10);
      const snapshot={room:room.rows[0],members:members.rows,tasks:tasks.rows,messages:messages.rows.reverse(),snapshot_seq:Number(room.rows[0].last_event_seq),briefing:{briefing_seq:Number(room.rows[0].last_event_seq),project_objective:room.rows[0].objective,participants:members.rows,joining_principal:{principal_id:actorId,role:member.role,responsibilities:member.responsibilities},active_tasks:active,relevant_completed_work:completed,unresolved_decisions:decisions.rows,blockers:active.filter((t:any)=>t.status==='blocked'),relevant_artifacts:[],important_recent_activity:events.rows.reverse()}};
      await c.query('COMMIT');
      return snapshot;
    } catch(e){await c.query('ROLLBACK');throw e;} finally { c.release(); }
  }

  async events(companyId:string,roomId:string,actorId:string,afterSeq:number,limit:number) { const c=await this.pool.connect(); try { await this.actor(c,companyId,actorId); await this.authorize(c,companyId,roomId,actorId,'room.read'); const result=await c.query(`SELECT id,room_seq,event_type,actor_principal_id,actor_kind,actor_display_name,entity_type,entity_id,entity_version,payload,command_id,correlation_id,created_at FROM room_events WHERE company_id=$1 AND room_id=$2 AND room_seq>$3 ORDER BY room_seq LIMIT $4`,[companyId,roomId,afterSeq,Math.min(limit,500)]); return {events:result.rows.map((e:any)=>({...e,room_seq:Number(e.room_seq)}))}; } finally{c.release();} }
}
