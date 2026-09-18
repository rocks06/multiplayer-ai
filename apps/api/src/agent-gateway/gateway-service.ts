import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { DbPool } from "../db.js";
import { DomainError } from "../../../../packages/domain/src/index.js";
import { SecurityAudit } from "../security/audit.js";

const hash = (secret:string) => createHash("sha256").update(secret).digest("hex");
const secret = (prefix:string) => `${prefix}_${randomBytes(32).toString("base64url")}`;

// Enrollment codes are typed by a person, so the alphabet excludes characters that are easy
// to confuse. Twelve characters over 32 symbols is ~1.2e18 combinations, and a code is
// additionally single-use and short-lived.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const enrollmentCode = () => {
  const bytes = randomBytes(12);
  const body = Array.from(bytes, byte => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `MPAI-${body.slice(0,4)}-${body.slice(4,8)}-${body.slice(8,12)}`;
};
const DEFAULT_ENROLLMENT_TTL_MINUTES = 15;

export interface GatewayIdentity {
  sessionId:string;
  credentialId:string;
  companyId:string;
  roomId:string;
  principalId:string;
  agentId:string;
  lastAckSeq:number;
}

export class AgentGatewayService {
  /** The room log, so a connection's life is visible where the work is, not only in a server log. */
  constructor(private readonly pool:DbPool, private readonly rooms?:{recordAgentEvent:(client:any,input:{companyId:string;roomId:string;agentPrincipalId:string;eventType:string;payload:Record<string,unknown>})=>Promise<void>}) {}

  private bearer(header:unknown) {
    if(typeof header!=="string" || !header.startsWith("Bearer ")) throw new DomainError("gateway_unauthenticated","Bearer token is required",401);
    const token=header.slice(7).trim();
    if(!token) throw new DomainError("gateway_unauthenticated","Bearer token is required",401);
    return token;
  }

  /**
   * Retire the sessions a replaced credential was running, in the transaction that replaced it.
   *
   * `authenticateSession` requires the owning credential to be active, so the instant a credential
   * is superseded every session it opened is refused — but the rows still said 'connected'. Home
   * went on reporting a working agent that could not make a single authenticated call, which is
   * the disagreement between the room and the Mac that made this look like two separate faults.
   * The session ends when the credential ends, and everyone hears about it at once.
   */
  private async retireSessionsOfReplacedCredential(
    c:{query:DbPool["query"]}, companyId:string, agentPrincipalId:string, replacedBy:string,
  ) {
    const retired=await c.query<{id:string;room_id:string}>(
      `UPDATE external_agent_sessions SET status='superseded',disconnected_at=now(),last_seen_at=now()
       WHERE company_id=$1 AND agent_principal_id=$2 AND status='connected' RETURNING id,room_id`,
      [companyId,agentPrincipalId]);
    for(const row of retired.rows){
      // Being replaced is not being shut out, and the reason travels so the connector can tell.
      await c.query(`SELECT pg_notify('agent_sessions',$1)`,
        [JSON.stringify({session_id:row.id,reason:"credential_replaced"})]);
      if(this.rooms) await this.rooms.recordAgentEvent(c,{companyId,roomId:row.room_id,
        agentPrincipalId,eventType:"agent.session.superseded",
        payload:{session_id:row.id,reason:"credential_replaced",credential_id:replacedBy}});
    }
    return retired.rows;
  }

  async createCredential(input:{companyId:string;actorId:string;agentPrincipalId:string;label:string}) {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      const actor=await c.query(`SELECT 1 FROM principals WHERE company_id=$1 AND id=$2 AND kind='human' AND status='active'`,[input.companyId,input.actorId]);
      if(!actor.rowCount) throw new DomainError("permission_denied","An active company human must provision machine credentials",403);
      const agent=await c.query<{agent_id:string}>(`SELECT p.agent_id FROM principals p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.status='active' AND a.status='active'`,[input.companyId,input.agentPrincipalId]);
      if(!agent.rowCount) throw new DomainError("agent_not_found","Active company agent principal not found",404);
      /* One runtime, one credential. Re-enrolling or moving rooms is the same machine coming
         back, not a second one, so the credential it used before is retired rather than left
         active beside the new one — which is what let a machine keep working against a room it
         had supposedly left. The principal is untouched: the agent's identity survives, only its
         key changes. */
      await c.query(
        `UPDATE external_agent_credentials SET status='superseded',revoked_at=now()
         WHERE company_id=$1 AND agent_principal_id=$2 AND status='active'`,
        [input.companyId,input.agentPrincipalId]);
      const id=uuidv7(),token=secret("magc");
      await c.query(`INSERT INTO external_agent_credentials(id,company_id,agent_principal_id,token_hash,token_prefix,label,created_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,input.companyId,input.agentPrincipalId,hash(token),token.slice(0,12),input.label,input.actorId]);
      await this.retireSessionsOfReplacedCredential(c,input.companyId,input.agentPrincipalId,id);
      await c.query("COMMIT");
      return {id,company_id:input.companyId,agent_principal_id:input.agentPrincipalId,label:input.label,credential_token:token};
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  /**
   * Issue a single-use enrollment code for one agent principal. The raw code is returned
   * exactly once and only its digest is stored, so it cannot be recovered from the database.
   */
  /**
   * Issue a single-use enrollment code for one agent, in one room.
   *
   * The room is part of the code. It used to be absent, and redemption had to guess which room
   * was meant — it returned every room the agent belonged to, oldest membership first, and the
   * connecting machine took the first. Pressing Connect inside a room therefore bound the agent
   * to whichever room it had joined earliest, silently, with every screen afterwards reporting
   * success. A code now names the room it was issued from, and redeeming it can only ever
   * produce that room.
   */
  async createEnrollment(input:{companyId:string;actorId:string;agentPrincipalId:string;label:string;roomId?:string;ttlMinutes?:number}) {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      const actor=await c.query(`SELECT 1 FROM principals WHERE company_id=$1 AND id=$2 AND kind='human' AND status='active'`,[input.companyId,input.actorId]);
      if(!actor.rowCount) throw new DomainError("permission_denied","An active company human must issue enrollment codes",403);
      const agent=await c.query(`SELECT 1 FROM principals p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.status='active' AND a.status='active'`,[input.companyId,input.agentPrincipalId]);
      if(!agent.rowCount) throw new DomainError("agent_not_found","Active company agent principal not found",404);
      if (input.roomId) {
        // A code for a room the agent cannot work in would redeem into a session it is refused,
        // so it is refused here instead, while somebody is still looking at the screen.
        const member=await c.query(`SELECT 1 FROM room_members WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active' AND role='worker_agent'`,[input.companyId,input.roomId,input.agentPrincipalId]);
        if(!member.rowCount) throw new DomainError("enrollment_room_invalid","This agent is not a worker in that room",409);
      }
      const ttl=Math.min(Math.max(Number(input.ttlMinutes ?? DEFAULT_ENROLLMENT_TTL_MINUTES),1),60);
      const id=uuidv7(),code=enrollmentCode();
      const inserted=await c.query<{expires_at:string}>(`INSERT INTO agent_enrollment_tokens(id,company_id,agent_principal_id,room_id,code_hash,code_prefix,label,created_by_principal_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+($9||' minutes')::interval) RETURNING expires_at`,[id,input.companyId,input.agentPrincipalId,input.roomId??null,hash(code),code.slice(0,9),input.label,input.actorId,String(ttl)]);
      await c.query("COMMIT");
      return {id,company_id:input.companyId,agent_principal_id:input.agentPrincipalId,room_id:input.roomId??null,label:input.label,enrollment_code:code,expires_at:inserted.rows[0]!.expires_at};
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  /**
   * Exchange an enrollment code for a machine credential. Unauthenticated by design: the code
   * is the authentication. The agent principal comes from the token, never from the caller,
   * so an enrolling device cannot choose an identity.
   */
  async redeemEnrollment(input:{code:string;deviceLabel?:string}) {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Lock the still-usable code before checking anything that could make enrollment fail.
      // Concurrent redeemers serialize here; after the winner commits, the loser re-checks the
      // predicate and sees no pending token. Nothing is consumed until every prerequisite passes.
      const claimed=await c.query<{id:string;company_id:string;agent_principal_id:string;label:string;room_id:string|null}>(`SELECT id,company_id,agent_principal_id,label,room_id FROM agent_enrollment_tokens WHERE code_hash=$1 AND status='pending' AND expires_at>now() FOR UPDATE`,[hash(input.code)]);
      if(!claimed.rowCount) throw new DomainError("enrollment_invalid","Enrollment code is invalid, already used, or expired",401);
      const token=claimed.rows[0]!;
      const agent=await c.query(`SELECT 1 FROM principals p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.status='active' AND a.status='active'`,[token.company_id,token.agent_principal_id]);
      if(!agent.rowCount) throw new DomainError("agent_not_found","Agent principal is no longer active",404);
      /* Exactly the room the code was issued for, when it named one. The old query returned
         every room the agent belonged to and left the choice to whoever redeemed the code — which
         is how an agent connected from one room ended up bound to another. */
      const rooms=token.room_id
        ? await c.query(`SELECT r.id,r.name,p.name project_name FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id JOIN projects p ON p.company_id=r.company_id AND p.id=r.project_id WHERE rm.company_id=$1 AND rm.principal_id=$2 AND rm.room_id=$3 AND rm.status='active' AND rm.role='worker_agent'`,[token.company_id,token.agent_principal_id,token.room_id])
        : await c.query(`SELECT r.id,r.name,p.name project_name FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id JOIN projects p ON p.company_id=r.company_id AND p.id=r.project_id WHERE rm.company_id=$1 AND rm.principal_id=$2 AND rm.status='active' AND rm.role='worker_agent' ORDER BY rm.joined_at`,[token.company_id,token.agent_principal_id]);
      if(!rooms.rowCount) throw new DomainError("enrollment_room_required","Add this agent to a room before connecting it",409);
      // A code that names a room may only ever produce that room, never a substitute.
      if(token.room_id && rooms.rows.length!==1) throw new DomainError("enrollment_room_invalid","This agent is no longer a worker in that room",409);
      /* Same rule on the enrollment-code path: a machine redeeming a code is that agent coming
         back, so whatever key it held before is retired in this transaction. Without it, an
         agent moved between rooms kept a live credential for the room it had left. */
      await c.query(
        `UPDATE external_agent_credentials SET status='superseded',revoked_at=now()
         WHERE company_id=$1 AND agent_principal_id=$2 AND status='active'`,
        [token.company_id,token.agent_principal_id]);
      const credentialId=uuidv7(),credential=secret("magc");
      const label=input.deviceLabel?`${token.label} (${input.deviceLabel})`:token.label;
      await c.query(`INSERT INTO external_agent_credentials(id,company_id,agent_principal_id,token_hash,token_prefix,label,created_by_principal_id) SELECT $1,$2,$3,$4,$5,$6,created_by_principal_id FROM agent_enrollment_tokens WHERE id=$7`,[credentialId,token.company_id,token.agent_principal_id,hash(credential),credential.slice(0,12),label,token.id]);
      await c.query(`UPDATE agent_enrollment_tokens SET status='consumed',consumed_at=now(),device_label=$2,credential_id=$3 WHERE id=$1`,[token.id,input.deviceLabel??null,credentialId]);
      await this.retireSessionsOfReplacedCredential(c,token.company_id,token.agent_principal_id,credentialId);
      const name=await c.query<{display_name:string}>(`SELECT display_name FROM principals WHERE company_id=$1 AND id=$2`,[token.company_id,token.agent_principal_id]);
      await c.query("COMMIT");
      return {protocol:"agent-gateway.v1",credential_id:credentialId,credential_token:credential,company_id:token.company_id,agent_principal_id:token.agent_principal_id,agent_display_name:name.rows[0]?.display_name??null,rooms:rooms.rows};
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  async revokeCredential(input:{companyId:string;actorId:string;credentialId:string}) {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      const actor=await c.query(`SELECT 1 FROM principals WHERE company_id=$1 AND id=$2 AND kind='human' AND status='active'`,[input.companyId,input.actorId]);
      if(!actor.rowCount) throw new DomainError("permission_denied","An active company human must revoke machine credentials",403);
      const changed=await c.query(`UPDATE external_agent_credentials SET status='revoked',revoked_at=now() WHERE id=$1 AND company_id=$2 AND status='active' RETURNING id`,[input.credentialId,input.companyId]);
      if(!changed.rowCount) throw new DomainError("credential_not_found","Active credential not found",404);
      await c.query(`UPDATE external_agent_sessions SET status='revoked',disconnected_at=now(),last_seen_at=now() WHERE credential_id=$1 AND status='connected'`,[input.credentialId]);
      await c.query("COMMIT");
      return {id:input.credentialId,status:"revoked"};
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  async authenticateCredential(authorization:unknown) {
    const token=this.bearer(authorization);
    const result=await this.pool.query<{id:string;company_id:string;agent_principal_id:string;agent_id:string}>(`SELECT c.id,c.company_id,c.agent_principal_id,p.agent_id FROM external_agent_credentials c JOIN principals p ON p.company_id=c.company_id AND p.id=c.agent_principal_id JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE c.token_hash=$1 AND c.status='active' AND p.kind='agent' AND p.status='active' AND a.status='active'`,[hash(token)]);
    if(!result.rowCount){
      // A revoked, replaced or invented credential. Who presented it is unknown by definition, so
      // only that it happened is kept — never the token, not even its prefix.
      await new SecurityAudit(this.pool).record({actorKind:"anonymous",action:"agent.credential.authenticate",decision:"denied",reason:"credential_invalid"});
      throw new DomainError("gateway_unauthenticated","Credential is invalid or revoked",401);
    }
    await this.pool.query(`UPDATE external_agent_credentials SET last_used_at=now() WHERE id=$1`,[result.rows[0]!.id]);
    return result.rows[0]!;
  }

  async listRooms(authorization:unknown) {
    const auth=await this.authenticateCredential(authorization);
    const rooms=await this.pool.query(`SELECT r.id,r.name,r.project_id,p.name project_name,p.objective,rm.role,rm.responsibilities,r.last_event_seq FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id JOIN projects p ON p.company_id=r.company_id AND p.id=r.project_id WHERE rm.company_id=$1 AND rm.principal_id=$2 AND rm.status='active' ORDER BY rm.joined_at`,[auth.company_id,auth.agent_principal_id]);
    return {protocol:"agent-gateway.v1",company_id:auth.company_id,agent_principal_id:auth.agent_principal_id,rooms:rooms.rows.map((r:any)=>({...r,last_event_seq:Number(r.last_event_seq)}))};
  }

  /**
   * Open a session, and retire whatever this agent had before it.
   *
   * One runtime is one agent, so a second live session is not a second worker — it is the same
   * machine reconnecting, or a stale row from a connection that went away without saying so.
   * Leaving both meant every presence query resolved the pair by whichever heartbeat landed last,
   * so an agent flickered between connected and absent with nothing wrong with the connection.
   * Retiring happens in the same transaction as the insert, so there is never an instant with two
   * live rows and never one with none.
   *
   * The old socket is told rather than left to discover it: the superseded session's next
   * authentication fails, which is what closes it, and the notify below closes it sooner.
   */
  async openSession(authorization:unknown,roomId:string,runtimeStatus:"idle"|"working"="idle") {
    const auth=await this.authenticateCredential(authorization);
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      // Serialize this single-room principal's opens/resumes, including different rooms.
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[auth.agent_principal_id]);
      const member=await c.query(`SELECT 1 FROM room_members WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active' AND role='worker_agent' FOR UPDATE`,[auth.company_id,roomId,auth.agent_principal_id]);
      if(!member.rowCount){
        /* Recorded against this agent's own workspace, never the room it named: an id guessed from
           another workspace must not become a write into that workspace's records. */
        await new SecurityAudit(this.pool).record({companyId:auth.company_id,actorKind:"agent",actorPrincipalId:auth.agent_principal_id,
          action:"agent.session.open",decision:"denied",reason:"room_access_denied",targetType:"room",targetId:roomId});
        throw new DomainError("room_access_denied","Active worker-agent room membership is required",403);
      }
      const superseded=await c.query<{id:string;room_id:string}>(
        `UPDATE external_agent_sessions SET status='superseded',disconnected_at=now()
         WHERE company_id=$1 AND agent_principal_id=$2 AND status IN ('connected','offline') RETURNING id,room_id`,
        [auth.company_id,auth.agent_principal_id]);
      const retiredCredentials=await c.query<{id:string}>(
        `SELECT id FROM external_agent_credentials WHERE company_id=$1 AND agent_principal_id=$2
           AND status='superseded' AND revoked_at > now()-interval '1 minute'`,
        [auth.company_id,auth.agent_principal_id]);
      const id=uuidv7(),token=secret("mags");
      await c.query(`INSERT INTO external_agent_sessions(id,credential_id,company_id,agent_principal_id,room_id,session_token_hash,status,runtime_status) VALUES($1,$2,$3,$4,$5,$6,'connected',$7)`,[id,auth.id,auth.company_id,auth.agent_principal_id,roomId,hash(token),runtimeStatus]);
      // Whoever is holding those sockets should stop now, not at their next failed request.
      for(const row of superseded.rows) await c.query(`SELECT pg_notify('agent_sessions',$1)`,[JSON.stringify({session_id:row.id,reason:"superseded"})]);

      /* What happened, in the rooms it happened to. A replaced session is recorded in the room it
         was serving, which is the only room where its disappearance is visible. */
      if(this.rooms){
        for(const row of superseded.rows){
          await this.rooms.recordAgentEvent(c,{companyId:auth.company_id,roomId:row.room_id,
            agentPrincipalId:auth.agent_principal_id,eventType:"agent.session.superseded",
            payload:{session_id:row.id,replaced_by:id,reason:row.room_id===roomId?"reconnected":"moved"}});
        }
        const movedFrom=superseded.rows.find(row=>row.room_id!==roomId);
        await this.rooms.recordAgentEvent(c,{companyId:auth.company_id,roomId,
          agentPrincipalId:auth.agent_principal_id,
          eventType:movedFrom?"agent.session.moved":(superseded.rowCount?"agent.reconnected":"agent.session.connected"),
          payload:{session_id:id,room_id:roomId,
            ...(movedFrom?{moved_from_room_id:movedFrom.room_id}:{}),
            ...(retiredCredentials.rowCount?{credential_replaced:true}:{})}});
      }
      await c.query("COMMIT");
      return {protocol:"agent-gateway.v1",session_id:id,session_token:token,company_id:auth.company_id,room_id:roomId,agent_principal_id:auth.agent_principal_id,status:"connected",runtime_status:runtimeStatus,superseded:superseded.rows.map(r=>r.id)};
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  async authenticateSession(sessionId:string,authorization:unknown,touch=true,allowOffline=false):Promise<GatewayIdentity> {
    const token=this.bearer(authorization);
    const result=await this.pool.query<any>(`SELECT s.id session_id,s.credential_id,s.company_id,s.room_id,s.agent_principal_id,s.last_ack_room_seq,p.agent_id FROM external_agent_sessions s JOIN external_agent_credentials c ON c.id=s.credential_id AND c.company_id=s.company_id AND c.agent_principal_id=s.agent_principal_id JOIN principals p ON p.company_id=s.company_id AND p.id=s.agent_principal_id JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id JOIN room_members rm ON rm.company_id=s.company_id AND rm.room_id=s.room_id AND rm.principal_id=s.agent_principal_id WHERE s.id=$1 AND s.session_token_hash=$2 AND s.status = ANY($3::text[]) AND c.status='active' AND p.kind='agent' AND p.status='active' AND a.status='active' AND rm.status='active' AND rm.role='worker_agent'`,[sessionId,hash(token),allowOffline?["connected","offline"]:["connected"]]);
    if(!result.rowCount) throw new DomainError("gateway_session_invalid","Session is invalid, revoked, or no longer authorized",401);
    const row=result.rows[0]!;
    if(touch) await this.pool.query(`UPDATE external_agent_sessions SET last_seen_at=now() WHERE id=$1`,[sessionId]);
    return {sessionId:row.session_id,credentialId:row.credential_id,companyId:row.company_id,roomId:row.room_id,principalId:row.agent_principal_id,agentId:row.agent_id,lastAckSeq:Number(row.last_ack_room_seq)};
  }

  async resumeSession(sessionId:string,authorization:unknown) {
    const identity=await this.authenticateSession(sessionId,authorization,false,true);
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[identity.principalId]);
      const resumed=await c.query(`UPDATE external_agent_sessions SET status='connected',connected_at=now(),disconnected_at=NULL,last_seen_at=now()
        WHERE id=$1 AND status IN ('connected','offline') AND NOT EXISTS
        (SELECT 1 FROM external_agent_sessions other WHERE other.agent_principal_id=$2 AND other.status='connected' AND other.id<>$1) RETURNING id`,[sessionId,identity.principalId]);
      if(!resumed.rowCount) throw new DomainError('gateway_session_invalid','Session was replaced by another room connection',401);
      await c.query('COMMIT');
      return identity;
    } catch(error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }

  // Read-only session status. A runtime must be able to ask whether the Gateway still
  // considers its session connected without a heartbeat pretending the runtime is alive,
  // and an already-offline session must report as offline rather than 401.
  async describeSession(sessionId:string,authorization:unknown) {
    const identity=await this.authenticateSession(sessionId,authorization,false,true);
    const result=await this.pool.query<any>(`SELECT id,status,runtime_status,last_ack_room_seq,connected_at,disconnected_at,last_seen_at FROM external_agent_sessions WHERE id=$1`,[sessionId]);
    const row=result.rows[0]!;
    const cursor=await this.pool.query<{last_event_seq:string}>(`SELECT last_event_seq FROM rooms WHERE company_id=$1 AND id=$2`,[identity.companyId,identity.roomId]);
    return {protocol:"agent-gateway.v1",session_id:row.id,company_id:identity.companyId,room_id:identity.roomId,agent_principal_id:identity.principalId,status:row.status,runtime_status:row.runtime_status,last_ack_room_seq:Number(row.last_ack_room_seq),room_last_event_seq:Number(cursor.rows[0]!.last_event_seq),connected_at:row.connected_at,disconnected_at:row.disconnected_at,last_seen_at:row.last_seen_at};
  }

  /**
   * A heartbeat, and the one transition inside it worth recording.
   *
   * An agent going from idle to working is it waking up and starting on something — the moment a
   * person watching wants to see, and the proof that an addressed message actually reached a
   * runtime rather than merely being stored. Only the transition is logged: recording every
   * heartbeat would bury the room's history in a metronome.
   */
  async heartbeat(sessionId:string,authorization:unknown,runtimeStatus:"idle"|"working") {
    const identity=await this.authenticateSession(sessionId,authorization,false);
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      const before=await c.query<{runtime_status:string;room_id:string}>(
        `UPDATE external_agent_sessions SET runtime_status=$2,last_seen_at=now() WHERE id=$1
         RETURNING (SELECT runtime_status FROM external_agent_sessions WHERE id=$1) AS runtime_status,room_id`,
        [sessionId,runtimeStatus]);
      const changed=before.rows[0]?.runtime_status!==runtimeStatus;
      if(changed && this.rooms){
        await this.rooms.recordAgentEvent(c,{companyId:identity.companyId,roomId:identity.roomId,
          agentPrincipalId:identity.principalId,eventType:runtimeStatus==="working"?"agent.woke":"agent.idle",
          payload:{session_id:sessionId}});
      }
      await c.query("COMMIT");
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    return {session_id:sessionId,status:"connected",runtime_status:runtimeStatus,last_seen_at:new Date().toISOString(),agent_principal_id:identity.principalId};
  }

  async acknowledge(sessionId:string,authorization:unknown,roomSeq:number) {
    const identity=await this.authenticateSession(sessionId,authorization,false);
    const cursor=await this.pool.query<{last_event_seq:string}>(`SELECT last_event_seq FROM rooms WHERE company_id=$1 AND id=$2`,[identity.companyId,identity.roomId]);
    const latest=Number(cursor.rows[0]!.last_event_seq);
    if(roomSeq>latest) throw new DomainError("ack_ahead","Cannot acknowledge beyond the durable room cursor",409);
    await this.pool.query(`UPDATE external_agent_sessions SET last_ack_room_seq=GREATEST(last_ack_room_seq,$2),last_seen_at=now() WHERE id=$1`,[sessionId,roomSeq]);
  }

  async disconnect(sessionId:string,authorization:unknown) {
    const identity=await this.authenticateSession(sessionId,authorization,false,true);
    const c=await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,[identity.principalId]);
      const changed=await c.query(`UPDATE external_agent_sessions SET status='offline',runtime_status='idle',disconnected_at=now(),last_seen_at=now() WHERE id=$1 AND status='connected' RETURNING id`,[sessionId]);
      if(changed.rowCount && this.rooms) await this.rooms.recordAgentEvent(c,{companyId:identity.companyId,roomId:identity.roomId,
        agentPrincipalId:identity.principalId,eventType:'agent.session.disconnected',payload:{session_id:sessionId,reason:'disconnected'}});
      await c.query('COMMIT');
      return {session_id:sessionId,status:"offline"};
    } catch(error) { await c.query('ROLLBACK'); throw error; } finally { c.release(); }
  }
}
