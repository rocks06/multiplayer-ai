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

  /** Company records exist for room-only guests because principals are company-scoped. That is
   * not workspace authority. All workspace-wide reads and mutations pass this separate gate. */
  private async workspaceActor(client: DbClient, companyId: string, actorId: string): Promise<Actor> {
    const actor = await this.actor(client, companyId, actorId);
    if (actor.kind !== "human") throw new DomainError("workspace_access_denied", "Workspace access is required", 403);
    const access = await client.query(
      `SELECT 1 FROM principals p JOIN company_users cu ON cu.company_id=p.company_id AND cu.user_id=p.user_id
       WHERE p.company_id=$1 AND p.id=$2 AND cu.status='active' AND cu.access_scope='workspace'`,
      [companyId, actorId],
    );
    if (!access.rowCount) throw new DomainError("workspace_access_denied", "Workspace access is required", 403);
    return actor;
  }

  private async membership(client: DbClient, companyId: string, roomId: string, actorId: string): Promise<Membership> {
    const result = await client.query<Membership>(`SELECT rm.role,rm.responsibilities FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id WHERE rm.company_id=$1 AND rm.room_id=$2 AND rm.principal_id=$3 AND rm.status='active' AND r.status='active' FOR SHARE OF rm`, [companyId, roomId, actorId]);
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

  /**
   * Record something that happened to an agent's connection, in the room it happened to.
   *
   * These go in the same log as everything else on purpose. A person watching a room should be
   * able to see that an agent connected, that a second connection replaced the first, or that it
   * moved rooms — without reading a server log or inferring it from presence flickering. The
   * agent is the actor because it is: nobody asked for this on its behalf.
   *
   * Facts only. Nothing here estimates progress or predicts a finish, because the system cannot
   * know either.
   */
  async recordAgentEvent(client: DbClient, input: {
    companyId:string; roomId:string; agentPrincipalId:string; eventType:string; payload:Record<string,unknown>;
  }) {
    const actor = await this.actor(client, input.companyId, input.agentPrincipalId);
    const commandId = uuidv7();
    await this.appendEvent(client, {
      companyId: input.companyId, roomId: input.roomId, actor,
      eventType: input.eventType, entityType: "agent", entityId: input.agentPrincipalId,
      payload: input.payload, commandId, correlationId: commandId,
    });
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
  /**
   * Create a workspace on behalf of a signed-in user, in one transaction: the company, the
   * user's membership of it, and their human principal. A company without its creator as a
   * member would be unreachable, so these are never separate steps.
   */
  async createWorkspaceForUser(userId:string,name:string) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const user=await c.query<{display_name:string}>(`SELECT display_name FROM users WHERE id=$1`,[userId]);
      if(!user.rowCount) throw new DomainError('unauthenticated','Sign in to create a workspace',401);
      const companyId=uuidv7(),principalId=uuidv7();
      await c.query(`INSERT INTO companies(id,name) VALUES($1,$2)`,[companyId,name]);
      await c.query(`INSERT INTO company_users(company_id,user_id) VALUES($1,$2)`,[companyId,userId]);
      await c.query(`INSERT INTO principals(id,company_id,kind,user_id,display_name) VALUES($1,$2,'human',$3,$4)`,[principalId,companyId,userId,user.rows[0]!.display_name]);
      await c.query('COMMIT');
      return {company_id:companyId,name,principal_id:principalId,display_name:user.rows[0]!.display_name};
    } catch(e){ await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }

  /**
   * Agents in a company, with only what the product needs to choose and connect one.
   * Connector state is durable Gateway state, never inferred; no credential, digest, prefix,
   * session id, or cursor is exposed.
   */
  async listCompanyAgents(companyId:string,actorId:string) {
    const c=await this.pool.connect();
    try {
      await this.workspaceActor(c,companyId,actorId);
      const result=await c.query(`SELECT a.id agent_id,p.id principal_id,p.display_name,a.status,u.display_name owner_display_name,
        EXISTS(SELECT 1 FROM external_agent_credentials ec WHERE ec.company_id=a.company_id AND ec.agent_principal_id=p.id AND ec.status='active') connector_enrolled,
        CASE WHEN s.status IS NULL THEN 'never' WHEN s.status<>'connected' THEN s.status WHEN s.last_seen_at < now()-interval '90 seconds' THEN 'stale' ELSE 'connected' END presence,
        s.runtime_status,s.last_seen_at,s.room_id session_room_id,sr.name session_room_name,
        ri.runtime_type,ri.runtime_version,ri.endpoint runtime_endpoint,ri.probe_status,
        COALESCE(m.rooms,'[]'::jsonb) rooms
        FROM agents a
        JOIN principals p ON p.company_id=a.company_id AND p.agent_id=a.id AND p.kind='agent'
        LEFT JOIN users u ON u.id=a.owner_user_id
        LEFT JOIN LATERAL (SELECT es.status,es.runtime_status,es.last_seen_at,es.room_id FROM external_agent_sessions es WHERE es.company_id=a.company_id AND es.agent_principal_id=p.id ORDER BY es.last_seen_at DESC LIMIT 1) s ON true
        LEFT JOIN rooms sr ON sr.company_id=a.company_id AND sr.id=s.room_id
        LEFT JOIN agent_runtime_bindings arb ON arb.company_id=a.company_id AND arb.agent_principal_id=p.id AND arb.status='active'
        LEFT JOIN runtime_installations ri ON ri.company_id=arb.company_id AND ri.id=arb.runtime_installation_id
        LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('room_id',r.id,'name',r.name) ORDER BY r.name) rooms FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id WHERE rm.company_id=a.company_id AND rm.principal_id=p.id AND rm.status='active' AND r.status='active') m ON true
        WHERE a.company_id=$1 AND p.status='active' ORDER BY p.display_name`,[companyId]);
      return {agents:result.rows.map((row:any)=>({
        agent_id:row.agent_id,principal_id:row.principal_id,display_name:row.display_name,status:row.status,
        owner_display_name:row.owner_display_name,
        /* Which room the session is in, because this list is workspace-wide and the room view is
           not. "Connected" here with "never appeared" inside a room is the app disagreeing with
           itself; naming the room makes both answers true and the difference legible. */
        connector:{enrolled:row.connector_enrolled,presence:row.presence,runtime_status:row.runtime_status??null,last_seen_at:row.last_seen_at??null,room_id:row.session_room_id??null,room_name:row.session_room_name??null},
        runtime:row.runtime_type?{type:row.runtime_type,version:row.runtime_version??null,endpoint:row.runtime_endpoint,probe_status:row.probe_status}:null,
        rooms:row.rooms,
      }))};
    } finally { c.release(); }
  }

  async createHuman(companyId:string,email:string,displayName:string) { const userId=uuidv7(), principalId=uuidv7(); const c=await this.pool.connect(); try { await c.query('BEGIN'); await c.query(`INSERT INTO users(id,email,display_name) VALUES($1,$2,$3)`,[userId,email,displayName]); await c.query(`INSERT INTO company_users(company_id,user_id) VALUES($1,$2)`,[companyId,userId]); await c.query(`INSERT INTO principals(id,company_id,kind,user_id,display_name) VALUES($1,$2,'human',$3,$4)`,[principalId,companyId,userId,displayName]); await c.query('COMMIT'); return {user_id:userId,principal_id:principalId}; } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();} }
  async createAgent(companyId:string,ownerUserId:string,name:string) { const agentId=uuidv7(), principalId=uuidv7(); const c=await this.pool.connect(); try { await c.query('BEGIN'); await c.query(`INSERT INTO agents(id,company_id,owner_user_id,name) VALUES($1,$2,$3,$4)`,[agentId,companyId,ownerUserId,name]); await c.query(`INSERT INTO principals(id,company_id,kind,agent_id,display_name) VALUES($1,$2,'agent',$3,$4)`,[principalId,companyId,agentId,name]); await c.query('COMMIT'); return {agent_id:agentId,principal_id:principalId}; } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();} }
  /**
   * The rooms this person can open in a company, for resuming after sign-in and for finding the
   * way back into work. Scoped to their own active membership, so every room listed is one they
   * can actually enter — and a room with no agents in it lists like any other. The project is
   * carried only because a room is named within one and would otherwise be ambiguous.
   */
  async listRoomsForPrincipal(companyId:string,actorId:string) {
    const c=await this.pool.connect();
    try {
      await this.actor(c,companyId,actorId);
      const result=await c.query<{room_id:string;name:string;project_id:string;project_name:string;objective:string}>(
        `SELECT r.id room_id,r.name,p.id project_id,p.name project_name,p.objective
         FROM room_members rm
         JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id
         JOIN projects p ON p.company_id=r.company_id AND p.id=r.project_id
         WHERE rm.company_id=$1 AND rm.principal_id=$2 AND rm.status='active' AND r.status='active'
         ORDER BY r.created_at`,[companyId,actorId]);
      return {rooms:result.rows};
    } finally { c.release(); }
  }

  /**
   * Create an agent on behalf of an authenticated human principal. Ownership is derived from
   * who is acting, never from the request: a caller cannot name another user as the owner, and
   * a principal that is not active in the addressed company cannot create one at all.
   *
   * `createAgent` remains for direct service-level use (seeding, migrations), where there is no
   * request to derive an actor from.
   */
  async createAgentForPrincipal(companyId:string,actorId:string,name:string) {
    const c=await this.pool.connect();
    try {
      const actor=await this.workspaceActor(c,companyId,actorId);
      if(actor.kind!=='human') throw new DomainError('forbidden','Only a person can add an agent',403);
      const owner=await c.query<{user_id:string}>(`SELECT user_id FROM principals WHERE id=$1 AND company_id=$2 AND kind='human' AND status='active'`,[actorId,companyId]);
      const ownerUserId=owner.rows[0]?.user_id;
      if(!ownerUserId) throw new DomainError('forbidden','Principal is not active in this company',403);
      return this.createAgent(companyId,ownerUserId,name);
    } finally { c.release(); }
  }

  /** Resolve a stable runtime's existing name without binding, probing, or minting credentials. */
  async lookupRuntimeForPrincipal(input:{companyId:string;actorId:string;runtimeType:string;externalRuntimeId:string}) {
    const c=await this.pool.connect();
    try {
      await this.workspaceActor(c,input.companyId,input.actorId);
      const result=await c.query<{principal_id:string;display_name:string}>(
        `SELECT p.id AS principal_id,p.display_name FROM runtime_installations r
         JOIN agent_runtime_bindings b ON b.company_id=r.company_id AND b.runtime_installation_id=r.id
         JOIN principals p ON p.company_id=b.company_id AND p.id=b.agent_principal_id
         JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id
         WHERE r.company_id=$1 AND r.runtime_type=$2 AND r.external_runtime_id=$3
           AND b.status='active' AND p.status='active' AND p.kind='agent' AND a.status='active'`,
        [input.companyId,input.runtimeType,input.externalRuntimeId]);
      return {runtime:result.rows[0]??null};
    } finally { c.release(); }
  }

  /** Bind a validated physical runtime installation to one durable agent principal.
   *
   * The stable key is `(company, runtime_type, external_runtime_id)`. Credentials, connector
   * installations, sessions, room memberships and display names are observations around that key,
   * never evidence that a second runtime exists. A reconnect therefore returns the principal that
   * is already bound. `createAsNew` is the sole explicit escape hatch and retires the old binding.
   */
  async connectRuntimeForPrincipal(input:{companyId:string;actorId:string;name:string;runtimeType:string;externalRuntimeId:string;connectorInstallationId:string;endpoint:string;runtimeVersion?:string;createAsNew:boolean}) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const actor=await this.workspaceActor(c,input.companyId,input.actorId);
      if(actor.kind!=='human')throw new DomainError('forbidden','Only a person can connect a runtime',403);
      const owner=await c.query<{user_id:string}>(`SELECT user_id FROM principals WHERE id=$1 AND company_id=$2 AND kind='human' AND status='active'`,[input.actorId,input.companyId]);
      const ownerUserId=owner.rows[0]?.user_id;
      if(!ownerUserId)throw new DomainError('forbidden','Principal is not active in this company',403);

      const installationId=uuidv7();
      const installation=await c.query<{id:string}>(
        `INSERT INTO runtime_installations(id,company_id,runtime_type,external_runtime_id,connector_installation_id,endpoint,runtime_version,probe_status)
         VALUES($1,$2,$3,$4,$5,$6,$7,'healthy')
         ON CONFLICT(company_id,runtime_type,external_runtime_id) DO UPDATE SET
           connector_installation_id=EXCLUDED.connector_installation_id,endpoint=EXCLUDED.endpoint,
           runtime_version=EXCLUDED.runtime_version,probe_status='healthy',last_seen_at=now()
         RETURNING id`,
        [installationId,input.companyId,input.runtimeType,input.externalRuntimeId,input.connectorInstallationId,input.endpoint,input.runtimeVersion??null]);
      const runtimeInstallationId=installation.rows[0]!.id;
      const current=await c.query<{agent_principal_id:string;agent_id:string;display_name:string}>(
        `SELECT b.agent_principal_id,p.agent_id,p.display_name FROM agent_runtime_bindings b
         JOIN principals p ON p.company_id=b.company_id AND p.id=b.agent_principal_id
         JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id
         WHERE b.company_id=$1 AND b.runtime_installation_id=$2 AND b.status='active'
         FOR UPDATE OF b`,[input.companyId,runtimeInstallationId]);
      if(current.rowCount&&!input.createAsNew){
        await c.query('COMMIT');
        const known=current.rows[0]!;
        return {agent_id:known.agent_id,principal_id:known.agent_principal_id,display_name:known.display_name,
          runtime_installation_id:runtimeInstallationId,reused:true,runtime_type:input.runtimeType,
          runtime_version:input.runtimeVersion??null,endpoint:input.endpoint,probe_status:'healthy' as const};
      }
      if(current.rowCount){
        await c.query(`UPDATE agent_runtime_bindings SET status='replaced',ended_at=now() WHERE company_id=$1 AND runtime_installation_id=$2 AND status='active'`,[input.companyId,runtimeInstallationId]);
        await c.query(`UPDATE external_agent_sessions SET status='superseded',disconnected_at=now() WHERE company_id=$1 AND agent_principal_id=$2 AND status='connected'`,[input.companyId,current.rows[0]!.agent_principal_id]);
        await c.query(`UPDATE external_agent_credentials SET status='revoked',revoked_at=now() WHERE company_id=$1 AND agent_principal_id=$2 AND status='active'`,[input.companyId,current.rows[0]!.agent_principal_id]);
      }
      const agentId=uuidv7(),principalId=uuidv7(),bindingId=uuidv7();
      await c.query(`INSERT INTO agents(id,company_id,owner_user_id,name) VALUES($1,$2,$3,$4)`,[agentId,input.companyId,ownerUserId,input.name]);
      await c.query(`INSERT INTO principals(id,company_id,kind,agent_id,display_name) VALUES($1,$2,'agent',$3,$4)`,[principalId,input.companyId,agentId,input.name]);
      await c.query(`INSERT INTO agent_runtime_bindings(id,company_id,runtime_installation_id,agent_principal_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5)`,[bindingId,input.companyId,runtimeInstallationId,principalId,input.actorId]);
      await c.query('COMMIT');
      return {agent_id:agentId,principal_id:principalId,display_name:input.name,
        runtime_installation_id:runtimeInstallationId,reused:false,runtime_type:input.runtimeType,
        runtime_version:input.runtimeVersion??null,endpoint:input.endpoint,probe_status:'healthy' as const};
    } catch(error){await c.query('ROLLBACK');throw error} finally{c.release()}
  }

  /** Remove an agent from current operation while preserving principals and attributed history. */
  async removeAgent(companyId:string,actorId:string,agentPrincipalId:string) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const actor=await this.workspaceActor(c,companyId,actorId);
      if(actor.kind!=='human')throw new DomainError('permission_denied','Only a workspace user can remove an agent',403);
      const target=await c.query<{agent_id:string;display_name:string}>(`SELECT agent_id,display_name FROM principals WHERE company_id=$1 AND id=$2 AND kind='agent' AND status='active' FOR UPDATE`,[companyId,agentPrincipalId]);
      if(!target.rowCount)throw new DomainError('agent_not_found','Active agent not found',404);
      const rooms=await c.query<{room_id:string}>(`SELECT room_id FROM room_members WHERE company_id=$1 AND principal_id=$2 AND status='active'`,[companyId,agentPrincipalId]);
      for(const room of rooms.rows){
        await this.appendEvent(c,{companyId,roomId:room.room_id,actor,eventType:'agent.removed',entityType:'agent',entityId:agentPrincipalId,payload:{principal_id:agentPrincipalId,display_name:target.rows[0]!.display_name},commandId:uuidv7(),correlationId:uuidv7()});
      }
      await c.query(`UPDATE external_agent_sessions SET status='revoked',disconnected_at=now() WHERE company_id=$1 AND agent_principal_id=$2 AND status='connected'`,[companyId,agentPrincipalId]);
      await c.query(`UPDATE external_agent_credentials SET status='revoked',revoked_at=now() WHERE company_id=$1 AND agent_principal_id=$2 AND status='active'`,[companyId,agentPrincipalId]);
      await c.query(`UPDATE agent_enrollment_tokens SET status='revoked' WHERE company_id=$1 AND agent_principal_id=$2 AND status='pending'`,[companyId,agentPrincipalId]);
      await c.query(`UPDATE agent_runtime_bindings SET status='removed',ended_at=now() WHERE company_id=$1 AND agent_principal_id=$2 AND status='active'`,[companyId,agentPrincipalId]);
      await c.query(`UPDATE room_members SET status='removed',removed_at=now() WHERE company_id=$1 AND principal_id=$2 AND status='active'`,[companyId,agentPrincipalId]);
      // 'disabled' is the word the schema has for an agent that is no longer available; 'archived'
      // is not in its CHECK, so removing an agent failed with a constraint violation every time.
      await c.query(`UPDATE agents SET status='disabled',run_generation=run_generation+1 WHERE company_id=$1 AND id=$2`,[companyId,target.rows[0]!.agent_id]);
      await c.query(`UPDATE principals SET status='disabled' WHERE company_id=$1 AND id=$2`,[companyId,agentPrincipalId]);
      await c.query('COMMIT');
      return {principal_id:agentPrincipalId,status:'removed'};
    } catch(error){await c.query('ROLLBACK');throw error} finally{c.release()}
  }

  /** Delete operational room access, not its audit trail. */
  async deleteRoom(companyId:string,roomId:string,actorId:string) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const actor=await this.workspaceActor(c,companyId,actorId);
      const membership=await this.membership(c,companyId,roomId,actorId);
      if(membership.role!=='manager')throw new DomainError('permission_denied','Room manager access is required to delete this room',403);
      const room=await c.query<{name:string}>(`SELECT name FROM rooms WHERE company_id=$1 AND id=$2 AND status='active' FOR UPDATE`,[companyId,roomId]);
      if(!room.rowCount)throw new DomainError('room_not_found','Active room not found',404);
      const commandId=uuidv7();
      await this.appendEvent(c,{companyId,roomId,actor,eventType:'room.deleted',entityType:'room',entityId:roomId,payload:{name:room.rows[0]!.name},commandId,correlationId:commandId});
      const credentials=await c.query<{credential_id:string}>(`SELECT DISTINCT credential_id FROM external_agent_sessions WHERE company_id=$1 AND room_id=$2 AND status='connected'`,[companyId,roomId]);
      await c.query(`UPDATE external_agent_sessions SET status='revoked',disconnected_at=now() WHERE company_id=$1 AND room_id=$2 AND status='connected'`,[companyId,roomId]);
      if(credentials.rows.length)await c.query(`UPDATE external_agent_credentials SET status='revoked',revoked_at=now() WHERE company_id=$1 AND id=ANY($2::uuid[]) AND status='active'`,[companyId,credentials.rows.map(row=>row.credential_id)]);
      await c.query(`UPDATE agent_enrollment_tokens SET status='revoked' WHERE company_id=$1 AND room_id=$2 AND status='pending'`,[companyId,roomId]);
      await c.query(`UPDATE room_members SET status='removed',removed_at=now() WHERE company_id=$1 AND room_id=$2 AND status='active'`,[companyId,roomId]);
      await c.query(`UPDATE rooms SET status='deleted',deleted_at=now() WHERE company_id=$1 AND id=$2`,[companyId,roomId]);
      await c.query('COMMIT');
      return {id:roomId,status:'deleted'};
    } catch(error){await c.query('ROLLBACK');throw error} finally{c.release()}
  }

  async createProject(companyId:string,actorId:string,name:string,objective:string) { const c=await this.pool.connect(); try { await this.workspaceActor(c,companyId,actorId); const id=uuidv7(); await c.query(`INSERT INTO projects(id,company_id,name,objective,created_by_principal_id) VALUES($1,$2,$3,$4,$5)`,[id,companyId,name,objective,actorId]); return {id,name,objective}; } finally { c.release(); } }
  /**
   * Projects own objectives; rooms only point at projects. No existing command updates that
   * field, so onboarding needs this small compare-and-set mutation to create the room first.
   * Projects do not have a version column. Locking the row and comparing its prior objective
   * gives the same stale-write refusal as versioned room commands, while replaying the already
   * applied value is harmless and idempotent.
   */
  async setProjectObjective(companyId:string,projectId:string,actorId:string,objective:string,expectedObjective:string) {
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      const actor=await this.workspaceActor(c,companyId,actorId);
      if(actor.kind!=='human')throw new DomainError('permission_denied','Only a person can set the project objective',403);
      const project=await c.query<{id:string;name:string;objective:string}>(
        `SELECT id,name,objective FROM projects WHERE company_id=$1 AND id=$2 FOR UPDATE`,[companyId,projectId]);
      if(!project.rowCount)throw new DomainError('project_not_found','Project not found',404);
      const manager=await c.query(`SELECT 1 FROM rooms r JOIN room_members rm ON rm.company_id=r.company_id AND rm.room_id=r.id
        WHERE r.company_id=$1 AND r.project_id=$2 AND rm.principal_id=$3 AND rm.status='active' AND rm.role='manager' LIMIT 1`,
        [companyId,projectId,actorId]);
      if(!manager.rowCount)throw new DomainError('permission_denied','Active room manager access is required to set the objective',403);
      const current=project.rows[0]!;
      if(current.objective===objective){await c.query('COMMIT');return current}
      if(current.objective!==expectedObjective)throw new DomainError('version_conflict','Project objective changed since it was read',409,{expected_objective:expectedObjective,current_objective:current.objective});
      const changed=await c.query<{id:string;name:string;objective:string}>(
        `UPDATE projects SET objective=$3 WHERE company_id=$1 AND id=$2 RETURNING id,name,objective`,[companyId,projectId,objective]);
      await c.query('COMMIT');
      return changed.rows[0]!;
    } catch(error){await c.query('ROLLBACK');throw error} finally{c.release()}
  }
  async createRoom(companyId:string,projectId:string,actorId:string,name:string,responsibilities:string) { const c=await this.pool.connect(); try { await c.query('BEGIN'); const actor=await this.workspaceActor(c,companyId,actorId); const roomId=uuidv7(), memberId=uuidv7(), commandId=uuidv7(); await c.query(`INSERT INTO rooms(id,company_id,project_id,name,created_by_principal_id) VALUES($1,$2,$3,$4,$5)`,[roomId,companyId,projectId,name,actorId]); await c.query(`INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities) VALUES($1,$2,$3,$4,'manager',$5)`,[memberId,companyId,roomId,actorId,responsibilities]); await this.appendEvent(c,{companyId,roomId,actor,eventType:'room.created',entityType:'room',entityId:roomId,payload:{name},commandId,correlationId:commandId}); await this.appendEvent(c,{companyId,roomId,actor,eventType:'member.joined',entityType:'room_member',entityId:memberId,payload:{principal_id:actorId,role:'manager'},commandId,correlationId:commandId}); await c.query('COMMIT'); return {id:roomId,name,room_seq:2}; } catch(e){await c.query('ROLLBACK');throw e;} finally{c.release();} }

  async addMember(input:{companyId:string;roomId:string;actorId:string;principalId:string;role:RoomRole;responsibilities:string;idempotencyKey:string}) { return this.command({...input,commandType:'member.add',input:{principalId:input.principalId,role:input.role,responsibilities:input.responsibilities},permission:'member.manage'}, async(c)=>{ const target=await this.actor(c,input.companyId,input.principalId);
    /* Somebody who left a room can be put back in it. A membership row is kept when it ends — its
       history matters — and the unique index spans ended rows too, so adding an agent back after a
       Disconnect failed outright and it could never connect to that room again. The ended row is
       reactivated instead; an active one is still a conflict, exactly as before. */
    const joined=await c.query<{id:string}>(`INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT (room_id,principal_id) DO UPDATE SET status='active',removed_at=NULL,joined_at=now(),role=EXCLUDED.role,responsibilities=EXCLUDED.responsibilities
      WHERE room_members.status<>'active' RETURNING id`,[uuidv7(),input.companyId,input.roomId,input.principalId,input.role,input.responsibilities]);
    if(!joined.rowCount) throw new DomainError('member_exists','Already a member of this room',409);
    const id=joined.rows[0]!.id;
    return {response:{id,principal_id:target.id,role:input.role},event:{type:'member.joined',entityType:'room_member',entityId:id,payload:{principal_id:target.id,role:input.role}}}; }); }

  async removeMember(input:{companyId:string;roomId:string;actorId:string;principalId:string;idempotencyKey:string}) {
    return this.command({...input,commandType:'member.remove',input:{principalId:input.principalId},permission:'member.manage'}, async(c)=>{
      const target=await this.actor(c,input.companyId,input.principalId);
      const removed=await c.query<{id:string}>(`UPDATE room_members SET status='removed',removed_at=now() WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active' RETURNING id`,[input.companyId,input.roomId,input.principalId]);
      if(!removed.rowCount) throw new DomainError('member_not_found','Active room member not found',404);
      if(target.kind==='agent'){
        /* Out of this room, not out of the workspace. The session here ends now and whoever holds
           it is told at once; the credential is the agent's own, not this room's, so it is kept —
           revoking it meant reconnecting the agent anywhere needed a new code. */
        const ended=await c.query<{id:string}>(`UPDATE external_agent_sessions SET status='revoked',disconnected_at=now() WHERE company_id=$1 AND room_id=$2 AND agent_principal_id=$3 AND status IN ('connected','offline') RETURNING id`,[input.companyId,input.roomId,input.principalId]);
        for(const row of ended.rows)await c.query(`SELECT pg_notify('agent_sessions',$1)`,[JSON.stringify({session_id:row.id,reason:'removed_from_room'})]);
        await c.query(`UPDATE agent_enrollment_tokens SET status='revoked' WHERE company_id=$1 AND room_id=$2 AND agent_principal_id=$3 AND status='pending'`,[input.companyId,input.roomId,input.principalId]);
      }
      const id=removed.rows[0]!.id;
      return {response:{id,principal_id:input.principalId,status:'removed'},event:{type:'member.removed',entityType:'room_member',entityId:id,payload:{principal_id:input.principalId,status:'removed'}}};
    });
  }

  async roomCursor(companyId:string,roomId:string,actorId:string) {
    const result=await this.pool.query<{last_event_seq:string}>(`SELECT r.last_event_seq FROM rooms r JOIN principals p ON p.company_id=r.company_id AND p.id=$3 AND p.status='active' JOIN room_members rm ON rm.company_id=r.company_id AND rm.room_id=r.id AND rm.principal_id=p.id AND rm.status='active' WHERE r.company_id=$1 AND r.id=$2`,[companyId,roomId,actorId]);
    if(!result.rowCount) throw new DomainError('room_access_denied','Active room membership is required',403);
    return Number(result.rows[0]!.last_event_seq);
  }

  async sendMessage(input:{companyId:string;roomId:string;actorId:string;addressedPrincipalId?:string;body:string;artifactIds?:string[];taskId?:string;inReplyToMessageId?:string;idempotencyKey:string;runGuard?:RunGuard}) {
    const artifactIds=[...new Set(input.artifactIds??[])];
    if(!input.body.trim()&&!artifactIds.length)throw new DomainError('message_empty','Write a message or attach a file',400);
    if(artifactIds.length>10)throw new DomainError('too_many_artifacts','Attach at most ten files per message',400);
    return this.command({...input,commandType:'message.send',input:{addressedPrincipalId:input.addressedPrincipalId,body:input.body,taskId:input.taskId,inReplyToMessageId:input.inReplyToMessageId,artifactIds},permission:'message.send'},async(c)=>{
      if(input.addressedPrincipalId)await this.membership(c,input.companyId,input.roomId,input.addressedPrincipalId);
      if(input.inReplyToMessageId){
        const parent=await c.query(`SELECT 1 FROM messages WHERE company_id=$1 AND room_id=$2 AND id=$3`,[input.companyId,input.roomId,input.inReplyToMessageId]);
        if(!parent.rowCount)throw new DomainError('message_not_found','The message being replied to is not in this room',404);
      }
      const id=uuidv7();
      await c.query(`INSERT INTO messages(id,company_id,room_id,sender_principal_id,addressed_principal_id,body_text,task_id,in_reply_to_message_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,input.companyId,input.roomId,input.actorId,input.addressedPrincipalId??null,input.body,input.taskId??null,input.inReplyToMessageId??null]);
      // Association and message.sent commit together. Realtime readers cannot see a half-message.
      for(const [position,artifactId]of artifactIds.entries()){
        const ready=await c.query(`SELECT 1 FROM artifacts WHERE company_id=$1 AND room_id=$2 AND id=$3 AND status='ready' FOR SHARE`,[input.companyId,input.roomId,artifactId]);
        if(!ready.rowCount)throw new DomainError('artifact_not_ready','That file is not available in this room',409);
        await c.query(`INSERT INTO message_artifacts(company_id,room_id,message_id,artifact_id,position) VALUES($1,$2,$3,$4,$5)`,[input.companyId,input.roomId,id,artifactId,position]);
      }
      const response={id,body_text:input.body,addressed_principal_id:input.addressedPrincipalId??null,in_reply_to_message_id:input.inReplyToMessageId??null,artifact_ids:artifactIds};
      return {response,event:{type:'message.sent',entityType:'message',entityId:id,payload:response}};
    });
  }

  async createTask(input:{companyId:string;roomId:string;actorId:string;title:string;description:string;assigneePrincipalId?:string;idempotencyKey:string}) { return this.command({...input,commandType:'task.create',input:{title:input.title,description:input.description,assigneePrincipalId:input.assigneePrincipalId},permission:'task.create'}, async(c)=>{ if(input.assigneePrincipalId) await this.membership(c,input.companyId,input.roomId,input.assigneePrincipalId); const id=uuidv7(); await c.query(`INSERT INTO tasks(id,company_id,room_id,title,description,created_by_principal_id,assignee_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,input.companyId,input.roomId,input.title,input.description,input.actorId,input.assigneePrincipalId??null]); const response={id,title:input.title,status:'open' as TaskStatus,version:1,assignee_principal_id:input.assigneePrincipalId??null}; return {response,event:{type:'task.created',entityType:'task',entityId:id,entityVersion:1,payload:response}}; }); }

  async updateTaskStatus(input:{companyId:string;roomId:string;actorId:string;taskId:string;status:TaskStatus;expectedVersion:number;idempotencyKey:string;runGuard?:RunGuard}) { const client=await this.pool.connect(); let permission:Permission='task.update.own'; try { await client.query('BEGIN');const m=await this.membership(client,input.companyId,input.roomId,input.actorId); if(roleHasPermission(m.role,'task.update.any')) permission='task.update.any';await client.query('COMMIT'); } catch(e){await client.query('ROLLBACK');throw e;} finally{client.release();} return this.command({...input,commandType:'task.status.update',input:{taskId:input.taskId,status:input.status,expectedVersion:input.expectedVersion},permission}, async(c)=>{ const current=await c.query<{status:TaskStatus;version:number;assignee_principal_id:string|null}>(`SELECT status,version,assignee_principal_id FROM tasks WHERE id=$1 AND company_id=$2 AND room_id=$3 FOR UPDATE`,[input.taskId,input.companyId,input.roomId]); if(!current.rowCount)throw new DomainError('task_not_found','Task not found',404); const task=current.rows[0]!; if(permission==='task.update.own' && task.assignee_principal_id!==input.actorId)throw new DomainError('permission_denied','Only the assignee may update this task',403); if(task.version!==input.expectedVersion)throw new DomainError('version_conflict','Task changed since it was read',409,{expected_version:input.expectedVersion,current_version:task.version}); if(!canTransitionTask(task.status,input.status))throw new DomainError('invalid_task_transition',`Cannot transition ${task.status} to ${input.status}`,422); if(input.status==='in_progress')await this.assertDependenciesSatisfied(c,input.companyId,input.taskId); const updated=await c.query<{version:number}>(`UPDATE tasks SET status=$1,version=version+1,updated_at=now(),completed_at=CASE WHEN $1='completed' THEN now() ELSE completed_at END WHERE id=$2 AND company_id=$3 AND room_id=$4 AND version=$5 RETURNING version`,[input.status,input.taskId,input.companyId,input.roomId,input.expectedVersion]);if(!updated.rowCount)throw new DomainError('version_conflict','Task changed since it was read',409,{expected_version:input.expectedVersion});const nextVersion=updated.rows[0]!.version; const response={id:input.taskId,status:input.status,version:nextVersion}; return {response,event:{type:`task.${input.status}`,entityType:'task',entityId:input.taskId,entityVersion:nextVersion,payload:response}}; }); }

  /** Dependencies that are neither completed nor cancelled. A cancelled blocker will never
   * arrive, so it satisfies rather than blocking forever. */
  private async incompleteDependencies(client:DbClient,companyId:string,taskId:string) {
    const result=await client.query<{depends_on_task_id:string;title:string;status:TaskStatus;assignee_principal_id:string|null}>(`SELECT d.depends_on_task_id,t.title,t.status,t.assignee_principal_id FROM task_dependencies d JOIN tasks t ON t.company_id=d.company_id AND t.room_id=d.room_id AND t.id=d.depends_on_task_id WHERE d.company_id=$1 AND d.task_id=$2 AND t.status NOT IN ('completed','cancelled') ORDER BY t.created_at`,[companyId,taskId]);
    return result.rows;
  }

  private async assertDependenciesSatisfied(client:DbClient,companyId:string,taskId:string) {
    const override=await client.query<{dependency_override_at:string|null}>(`SELECT dependency_override_at FROM tasks WHERE company_id=$1 AND id=$2`,[companyId,taskId]);
    if(override.rows[0]?.dependency_override_at) return;
    const blocking=await this.incompleteDependencies(client,companyId,taskId);
    if(blocking.length) throw new DomainError('task_dependencies_incomplete','Task has incomplete dependencies',409,{blocked_by:blocking.map(row=>({task_id:row.depends_on_task_id,title:row.title,status:row.status,assignee_principal_id:row.assignee_principal_id}))});
  }

  async addTaskDependency(input:{companyId:string;roomId:string;actorId:string;taskId:string;dependsOnTaskId:string;idempotencyKey:string}) {
    return this.command({...input,commandType:'task.dependency.add',input:{taskId:input.taskId,dependsOnTaskId:input.dependsOnTaskId},permission:'task.update.any'}, async(c)=>{
      if(input.taskId===input.dependsOnTaskId) throw new DomainError('invalid_task_dependency','A task cannot depend on itself',422);
      // Locking the dependent task serialises this against a concurrent status transition,
      // so a dependency can never be added between the guard's check and the update.
      const target=await c.query<{version:number}>(`SELECT version FROM tasks WHERE company_id=$1 AND room_id=$2 AND id=$3 FOR UPDATE`,[input.companyId,input.roomId,input.taskId]);
      if(!target.rowCount) throw new DomainError('task_not_found','Task not found',404);
      const blocker=await c.query(`SELECT 1 FROM tasks WHERE company_id=$1 AND room_id=$2 AND id=$3`,[input.companyId,input.roomId,input.dependsOnTaskId]);
      if(!blocker.rowCount) throw new DomainError('task_not_found','Dependency task not found',404);
      // Direct reciprocal pairs would deadlock both tasks behind each other. Deeper cycles are
      // not detected; the plan scopes this to simple blocking, and an override stays audited.
      const reciprocal=await c.query(`SELECT 1 FROM task_dependencies WHERE company_id=$1 AND task_id=$2 AND depends_on_task_id=$3`,[input.companyId,input.dependsOnTaskId,input.taskId]);
      if(reciprocal.rowCount) throw new DomainError('invalid_task_dependency','That task already depends on this one',422);
      await c.query(`INSERT INTO task_dependencies(company_id,room_id,task_id,depends_on_task_id,created_by_principal_id) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[input.companyId,input.roomId,input.taskId,input.dependsOnTaskId,input.actorId]);
      // A new dependency retires any previous override, so a stale bypass cannot silently
      // permit work that a manager has not seen.
      await c.query(`UPDATE tasks SET dependency_override_at=NULL,dependency_override_by_principal_id=NULL,updated_at=now() WHERE company_id=$1 AND id=$2`,[input.companyId,input.taskId]);
      const response={task_id:input.taskId,depends_on_task_id:input.dependsOnTaskId};
      return {response,event:{type:'task.dependency_added',entityType:'task',entityId:input.taskId,entityVersion:target.rows[0]!.version,payload:response}};
    });
  }

  async removeTaskDependency(input:{companyId:string;roomId:string;actorId:string;taskId:string;dependsOnTaskId:string;idempotencyKey:string}) {
    return this.command({...input,commandType:'task.dependency.remove',input:{taskId:input.taskId,dependsOnTaskId:input.dependsOnTaskId},permission:'task.update.any'}, async(c)=>{
      const target=await c.query<{version:number}>(`SELECT version FROM tasks WHERE company_id=$1 AND room_id=$2 AND id=$3 FOR UPDATE`,[input.companyId,input.roomId,input.taskId]);
      if(!target.rowCount) throw new DomainError('task_not_found','Task not found',404);
      const removed=await c.query(`DELETE FROM task_dependencies WHERE company_id=$1 AND task_id=$2 AND depends_on_task_id=$3`,[input.companyId,input.taskId,input.dependsOnTaskId]);
      if(!removed.rowCount) throw new DomainError('task_dependency_not_found','Dependency not found',404);
      const response={task_id:input.taskId,depends_on_task_id:input.dependsOnTaskId};
      return {response,event:{type:'task.dependency_removed',entityType:'task',entityId:input.taskId,entityVersion:target.rows[0]!.version,payload:response}};
    });
  }

  /** Deliberately proceed despite incomplete dependencies. Manager-only, idempotent, and
   * recorded as its own event so the bypass is never invisible. */
  async overrideTaskDependencies(input:{companyId:string;roomId:string;actorId:string;taskId:string;reason:string;idempotencyKey:string}) {
    return this.command({...input,commandType:'task.dependency.override',input:{taskId:input.taskId,reason:input.reason},permission:'task.update.any'}, async(c,actor)=>{
      const target=await c.query<{version:number}>(`SELECT version FROM tasks WHERE company_id=$1 AND room_id=$2 AND id=$3 FOR UPDATE`,[input.companyId,input.roomId,input.taskId]);
      if(!target.rowCount) throw new DomainError('task_not_found','Task not found',404);
      const blocking=await this.incompleteDependencies(c,input.companyId,input.taskId);
      if(!blocking.length) throw new DomainError('no_incomplete_dependencies','This task has no incomplete dependencies to override',422);
      await c.query(`UPDATE tasks SET dependency_override_at=now(),dependency_override_by_principal_id=$3,updated_at=now() WHERE company_id=$1 AND id=$2`,[input.companyId,input.taskId,actor.id]);
      const response={task_id:input.taskId,reason:input.reason,overridden_by_principal_id:actor.id,overridden_dependencies:blocking.map(row=>row.depends_on_task_id)};
      return {response,event:{type:'task.dependency_override_granted',entityType:'task',entityId:input.taskId,entityVersion:target.rows[0]!.version,payload:response}};
    });
  }

  /** Hand a task to a different principal, or unassign it. Manager-only, optimistic, and
   * audited. Reassignment is a task mutation, so it takes and advances the version. */
  async reassignTask(input:{companyId:string;roomId:string;actorId:string;taskId:string;assigneePrincipalId:string|null;expectedVersion:number;idempotencyKey:string}) {
    return this.command({...input,commandType:'task.reassign',input:{taskId:input.taskId,assigneePrincipalId:input.assigneePrincipalId,expectedVersion:input.expectedVersion},permission:'task.update.any'}, async(c)=>{
      const current=await c.query<{status:TaskStatus;version:number;assignee_principal_id:string|null}>(`SELECT status,version,assignee_principal_id FROM tasks WHERE id=$1 AND company_id=$2 AND room_id=$3 FOR UPDATE`,[input.taskId,input.companyId,input.roomId]);
      if(!current.rowCount)throw new DomainError('task_not_found','Task not found',404);
      const task=current.rows[0]!;
      if(task.version!==input.expectedVersion)throw new DomainError('version_conflict','Task changed since it was read',409,{expected_version:input.expectedVersion,current_version:task.version});
      // Finished work has no owner to change; reopening is a separate decision.
      if(['completed','cancelled'].includes(task.status))throw new DomainError('task_not_reassignable',`Cannot reassign a ${task.status} task`,422);
      if(input.assigneePrincipalId)await this.membership(c,input.companyId,input.roomId,input.assigneePrincipalId);
      const updated=await c.query<{version:number}>(`UPDATE tasks SET assignee_principal_id=$1,version=version+1,updated_at=now() WHERE id=$2 AND company_id=$3 AND room_id=$4 AND version=$5 RETURNING version`,[input.assigneePrincipalId,input.taskId,input.companyId,input.roomId,input.expectedVersion]);
      if(!updated.rowCount)throw new DomainError('version_conflict','Task changed since it was read',409,{expected_version:input.expectedVersion});
      const response={id:input.taskId,status:task.status,assignee_principal_id:input.assigneePrincipalId,previous_assignee_principal_id:task.assignee_principal_id,version:updated.rows[0]!.version};
      return {response,event:{type:'task.reassigned',entityType:'task',entityId:input.taskId,entityVersion:updated.rows[0]!.version,payload:response}};
    });
  }

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
      // Agent presence is durable Gateway state, never inferred from room activity. 'stale'
      // marks a session the Gateway still calls connected but which has stopped reporting,
      // so a vanished runtime can never keep reading as live.
      const members=await c.query(`SELECT rm.principal_id,p.display_name,p.kind,rm.role,rm.responsibilities,s.status agent_connection,s.runtime_status agent_runtime_status,s.last_seen_at agent_last_seen_at,CASE WHEN p.kind<>'agent' THEN NULL WHEN s.status IS NULL THEN 'never' WHEN s.status<>'connected' THEN s.status WHEN s.last_seen_at < now()-interval '90 seconds' THEN 'stale' ELSE 'connected' END agent_presence,
        /* Where the agent actually is, when it is not here. A room-scoped query cannot tell a
           machine that has never connected from one that is connected to a different room, and
           reporting both as 'never' is what made a wrong-room binding look like a dead agent. */
        CASE WHEN p.kind='agent' AND elsewhere.room_id IS NOT NULL AND elsewhere.room_id<>rm.room_id THEN elsewhere.room_id END agent_session_room_id,
        CASE WHEN p.kind='agent' AND elsewhere.room_id IS NOT NULL AND elsewhere.room_id<>rm.room_id THEN other.name END agent_session_room_name
        FROM room_members rm JOIN principals p ON p.id=rm.principal_id LEFT JOIN LATERAL (SELECT es.status,es.runtime_status,es.last_seen_at FROM external_agent_sessions es WHERE es.company_id=rm.company_id AND es.room_id=rm.room_id AND es.agent_principal_id=rm.principal_id ORDER BY es.last_seen_at DESC LIMIT 1) s ON true
        LEFT JOIN LATERAL (SELECT es.room_id FROM external_agent_sessions es WHERE es.company_id=rm.company_id AND es.agent_principal_id=rm.principal_id AND es.status='connected' ORDER BY es.last_seen_at DESC LIMIT 1) elsewhere ON true
        LEFT JOIN rooms other ON other.company_id=rm.company_id AND other.id=elsewhere.room_id
        WHERE rm.room_id=$1 AND rm.company_id=$2 AND rm.status='active' ORDER BY rm.joined_at`,[roomId,companyId]);
      // Only incomplete blockers: a satisfied dependency is history, not a waiting state.
      const tasks=await c.query(`SELECT tk.id,tk.title,tk.description,tk.status,tk.assignee_principal_id,tk.version,tk.updated_at,tk.dependency_override_at,COALESCE(bd.blocked_by,'[]'::jsonb) blocked_by FROM tasks tk LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('task_id',dt.id,'title',dt.title,'status',dt.status,'assignee_principal_id',dt.assignee_principal_id) ORDER BY dt.created_at) blocked_by FROM task_dependencies d JOIN tasks dt ON dt.company_id=d.company_id AND dt.room_id=d.room_id AND dt.id=d.depends_on_task_id WHERE d.company_id=tk.company_id AND d.task_id=tk.id AND dt.status NOT IN ('completed','cancelled')) bd ON true WHERE tk.room_id=$1 AND tk.company_id=$2 ORDER BY tk.created_at`,[roomId,companyId]);
      const messages=await c.query(`SELECT m.id,m.sender_principal_id,m.addressed_principal_id,m.body_text,m.task_id,m.in_reply_to_message_id,m.created_at,p.display_name sender_name,p.kind sender_kind,
        /* The files this message delivered, with it rather than fetched per message afterwards.
           A filename in the text is not delivery; this is what the room can actually open. */
        COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'filename',a.filename,'content_type',a.content_type,'byte_size',a.byte_size,'metadata',a.metadata) ORDER BY ma.position)
                    FROM message_artifacts ma JOIN artifacts a ON a.company_id=ma.company_id AND a.id=ma.artifact_id
                   WHERE ma.company_id=m.company_id AND ma.message_id=m.id AND a.status='ready'),'[]'::jsonb) attachments
        FROM messages m JOIN principals p ON p.id=m.sender_principal_id WHERE m.room_id=$1 AND m.company_id=$2 ORDER BY m.created_at DESC LIMIT 50`,[roomId,companyId]);
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
