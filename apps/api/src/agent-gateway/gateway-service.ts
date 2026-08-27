import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import type { DbPool } from "../db.js";
import { DomainError } from "../../../../packages/domain/src/index.js";

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
  constructor(private readonly pool:DbPool) {}

  private bearer(header:unknown) {
    if(typeof header!=="string" || !header.startsWith("Bearer ")) throw new DomainError("gateway_unauthenticated","Bearer token is required",401);
    const token=header.slice(7).trim();
    if(!token) throw new DomainError("gateway_unauthenticated","Bearer token is required",401);
    return token;
  }

  async createCredential(input:{companyId:string;actorId:string;agentPrincipalId:string;label:string}) {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      const actor=await c.query(`SELECT 1 FROM principals WHERE company_id=$1 AND id=$2 AND kind='human' AND status='active'`,[input.companyId,input.actorId]);
      if(!actor.rowCount) throw new DomainError("permission_denied","An active company human must provision machine credentials",403);
      const agent=await c.query<{agent_id:string}>(`SELECT p.agent_id FROM principals p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.status='active' AND a.status='active'`,[input.companyId,input.agentPrincipalId]);
      if(!agent.rowCount) throw new DomainError("agent_not_found","Active company agent principal not found",404);
      const id=uuidv7(),token=secret("magc");
      await c.query(`INSERT INTO external_agent_credentials(id,company_id,agent_principal_id,token_hash,token_prefix,label,created_by_principal_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[id,input.companyId,input.agentPrincipalId,hash(token),token.slice(0,12),input.label,input.actorId]);
      await c.query("COMMIT");
      return {id,company_id:input.companyId,agent_principal_id:input.agentPrincipalId,label:input.label,credential_token:token};
    } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
  }

  /**
   * Issue a single-use enrollment code for one agent principal. The raw code is returned
   * exactly once and only its digest is stored, so it cannot be recovered from the database.
   */
  async createEnrollment(input:{companyId:string;actorId:string;agentPrincipalId:string;label:string;ttlMinutes?:number}) {
    const c=await this.pool.connect();
    try {
      await c.query("BEGIN");
      const actor=await c.query(`SELECT 1 FROM principals WHERE company_id=$1 AND id=$2 AND kind='human' AND status='active'`,[input.companyId,input.actorId]);
      if(!actor.rowCount) throw new DomainError("permission_denied","An active company human must issue enrollment codes",403);
      const agent=await c.query(`SELECT 1 FROM principals p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.status='active' AND a.status='active'`,[input.companyId,input.agentPrincipalId]);
      if(!agent.rowCount) throw new DomainError("agent_not_found","Active company agent principal not found",404);
      const ttl=Math.min(Math.max(Number(input.ttlMinutes ?? DEFAULT_ENROLLMENT_TTL_MINUTES),1),60);
      const id=uuidv7(),code=enrollmentCode();
      const inserted=await c.query<{expires_at:string}>(`INSERT INTO agent_enrollment_tokens(id,company_id,agent_principal_id,code_hash,code_prefix,label,created_by_principal_id,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+($8||' minutes')::interval) RETURNING expires_at`,[id,input.companyId,input.agentPrincipalId,hash(code),code.slice(0,9),input.label,input.actorId,String(ttl)]);
      await c.query("COMMIT");
      return {id,company_id:input.companyId,agent_principal_id:input.agentPrincipalId,label:input.label,enrollment_code:code,expires_at:inserted.rows[0]!.expires_at};
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
      // Consuming and validating in one statement is what makes a code single-use under
      // concurrent redemption attempts.
      const claimed=await c.query<{id:string;company_id:string;agent_principal_id:string;label:string}>(`UPDATE agent_enrollment_tokens SET status='consumed',consumed_at=now(),device_label=$2 WHERE code_hash=$1 AND status='pending' AND expires_at>now() RETURNING id,company_id,agent_principal_id,label`,[hash(input.code),input.deviceLabel??null]);
      if(!claimed.rowCount) throw new DomainError("enrollment_invalid","Enrollment code is invalid, already used, or expired",401);
      const token=claimed.rows[0]!;
      const agent=await c.query(`SELECT 1 FROM principals p JOIN agents a ON a.company_id=p.company_id AND a.id=p.agent_id WHERE p.company_id=$1 AND p.id=$2 AND p.kind='agent' AND p.status='active' AND a.status='active'`,[token.company_id,token.agent_principal_id]);
      if(!agent.rowCount) throw new DomainError("agent_not_found","Agent principal is no longer active",404);
      const credentialId=uuidv7(),credential=secret("magc");
      const label=input.deviceLabel?`${token.label} (${input.deviceLabel})`:token.label;
      await c.query(`INSERT INTO external_agent_credentials(id,company_id,agent_principal_id,token_hash,token_prefix,label,created_by_principal_id) SELECT $1,$2,$3,$4,$5,$6,created_by_principal_id FROM agent_enrollment_tokens WHERE id=$7`,[credentialId,token.company_id,token.agent_principal_id,hash(credential),credential.slice(0,12),label,token.id]);
      await c.query(`UPDATE agent_enrollment_tokens SET credential_id=$2 WHERE id=$1`,[token.id,credentialId]);
      const rooms=await c.query(`SELECT r.id,r.name,p.name project_name FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id JOIN projects p ON p.company_id=r.company_id AND p.id=r.project_id WHERE rm.company_id=$1 AND rm.principal_id=$2 AND rm.status='active' AND rm.role='worker_agent' ORDER BY rm.joined_at`,[token.company_id,token.agent_principal_id]);
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
    if(!result.rowCount) throw new DomainError("gateway_unauthenticated","Credential is invalid or revoked",401);
    await this.pool.query(`UPDATE external_agent_credentials SET last_used_at=now() WHERE id=$1`,[result.rows[0]!.id]);
    return result.rows[0]!;
  }

  async listRooms(authorization:unknown) {
    const auth=await this.authenticateCredential(authorization);
    const rooms=await this.pool.query(`SELECT r.id,r.name,r.project_id,p.name project_name,p.objective,rm.role,rm.responsibilities,r.last_event_seq FROM room_members rm JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id JOIN projects p ON p.company_id=r.company_id AND p.id=r.project_id WHERE rm.company_id=$1 AND rm.principal_id=$2 AND rm.status='active' ORDER BY rm.joined_at`,[auth.company_id,auth.agent_principal_id]);
    return {protocol:"agent-gateway.v1",company_id:auth.company_id,agent_principal_id:auth.agent_principal_id,rooms:rooms.rows.map((r:any)=>({...r,last_event_seq:Number(r.last_event_seq)}))};
  }

  async openSession(authorization:unknown,roomId:string,runtimeStatus:"idle"|"working"="idle") {
    const auth=await this.authenticateCredential(authorization);
    const member=await this.pool.query(`SELECT 1 FROM room_members WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active' AND role='worker_agent'`,[auth.company_id,roomId,auth.agent_principal_id]);
    if(!member.rowCount) throw new DomainError("room_access_denied","Active worker-agent room membership is required",403);
    const id=uuidv7(),token=secret("mags");
    await this.pool.query(`INSERT INTO external_agent_sessions(id,credential_id,company_id,agent_principal_id,room_id,session_token_hash,status,runtime_status) VALUES($1,$2,$3,$4,$5,$6,'connected',$7)`,[id,auth.id,auth.company_id,auth.agent_principal_id,roomId,hash(token),runtimeStatus]);
    return {protocol:"agent-gateway.v1",session_id:id,session_token:token,company_id:auth.company_id,room_id:roomId,agent_principal_id:auth.agent_principal_id,status:"connected",runtime_status:runtimeStatus};
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
    await this.pool.query(`UPDATE external_agent_sessions SET status='connected',connected_at=now(),disconnected_at=NULL,last_seen_at=now() WHERE id=$1`,[sessionId]);
    return identity;
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

  async heartbeat(sessionId:string,authorization:unknown,runtimeStatus:"idle"|"working") {
    const identity=await this.authenticateSession(sessionId,authorization,false);
    await this.pool.query(`UPDATE external_agent_sessions SET runtime_status=$2,last_seen_at=now() WHERE id=$1`,[sessionId,runtimeStatus]);
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
    await this.authenticateSession(sessionId,authorization,false);
    await this.pool.query(`UPDATE external_agent_sessions SET status='offline',disconnected_at=now(),last_seen_at=now() WHERE id=$1`,[sessionId]);
    return {session_id:sessionId,status:"offline"};
  }
}
