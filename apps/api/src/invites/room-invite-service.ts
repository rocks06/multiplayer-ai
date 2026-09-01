import { createHash, randomBytes } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { DomainError } from "../../../../packages/domain/src/index.js";
import type { DbPool } from "../db.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const inviteSecret = () => `mpri_${randomBytes(32).toString("base64url")}`;
const DEFAULT_TTL_HOURS = 24;

export class RoomInviteService {
  constructor(private readonly pool: DbPool) {}

  async issue(input: { companyId: string; roomId: string; actorId: string; ttlHours?: number }) {
    const manager = await this.pool.query(
      `SELECT 1
       FROM room_members rm
       JOIN principals p ON p.company_id=rm.company_id AND p.id=rm.principal_id AND p.kind='human' AND p.status='active'
       JOIN company_users cu ON cu.company_id=p.company_id AND cu.user_id=p.user_id
       WHERE rm.company_id=$1 AND rm.room_id=$2 AND rm.principal_id=$3
         AND rm.status='active' AND rm.role='manager'
         AND cu.status='active' AND cu.access_scope='workspace'`,
      [input.companyId, input.roomId, input.actorId],
    );
    if (!manager.rowCount) throw new DomainError("permission_denied", "Only a workspace-authorized room manager can invite people", 403);
    const ttl = Math.min(Math.max(Number(input.ttlHours ?? DEFAULT_TTL_HOURS), 1), 168);
    const id = uuidv7(), token = inviteSecret();
    const row = await this.pool.query<{ expires_at: string }>(
      `INSERT INTO room_invites(id,company_id,room_id,token_hash,token_prefix,created_by_principal_id,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,now()+($7||' hours')::interval) RETURNING expires_at`,
      [id, input.companyId, input.roomId, digest(token), token.slice(0, 12), input.actorId, String(ttl)],
    );
    return { id, invite_token: token, invite_path: `/join#${token}`, expires_at: row.rows[0]!.expires_at };
  }

  /** Safe possession proof: names only, no member list, ids, or account existence. */
  async preview(token: string) {
    const row = await this.pool.query<{ company_name: string; room_name: string; expires_at: string }>(
      `SELECT c.name company_name,r.name room_name,i.expires_at
       FROM room_invites i JOIN companies c ON c.id=i.company_id
       JOIN rooms r ON r.company_id=i.company_id AND r.id=i.room_id
       WHERE i.token_hash=$1 AND i.status='pending' AND i.expires_at>now()`, [digest(token)],
    );
    if (!row.rowCount) throw new DomainError("room_invite_invalid", "Invite is invalid, already used, or expired", 404);
    return row.rows[0]!;
  }

  async accept(token: string, userId: string) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const claimed = await client.query<{ id: string; company_id: string; room_id: string; role: "manager"|"contributor" }>(
        `SELECT id,company_id,room_id,role FROM room_invites
         WHERE token_hash=$1 AND status='pending' AND expires_at>now() FOR UPDATE`, [digest(token)],
      );
      if (!claimed.rowCount) throw new DomainError("room_invite_invalid", "Invite is invalid, already used, or expired", 404);
      const invite = claimed.rows[0]!;
      const user = await client.query<{ display_name: string }>("SELECT display_name FROM users WHERE id=$1", [userId]);
      if (!user.rowCount) throw new DomainError("unauthenticated", "Sign in to continue", 401);

      await client.query(
        `INSERT INTO company_users(company_id,user_id,status,access_scope) VALUES($1,$2,'active','room_only')
         ON CONFLICT(company_id,user_id) DO UPDATE SET
           status='active',
           access_scope=CASE
             WHEN company_users.status='active' AND company_users.access_scope='workspace' THEN 'workspace'
             ELSE 'room_only'
           END`, [invite.company_id, userId],
      );
      let principal = await client.query<{ id: string }>(
        `SELECT id FROM principals WHERE company_id=$1 AND user_id=$2 AND kind='human' ORDER BY created_at LIMIT 1`,
        [invite.company_id, userId],
      );
      let principalId = principal.rows[0]?.id;
      if (!principalId) {
        principalId = uuidv7();
        await client.query(
          `INSERT INTO principals(id,company_id,kind,user_id,display_name,status) VALUES($1,$2,'human',$3,$4,'active')`,
          [principalId, invite.company_id, userId, user.rows[0]!.display_name],
        );
      } else {
        await client.query("UPDATE principals SET status='active',display_name=$3 WHERE company_id=$1 AND id=$2", [invite.company_id, principalId, user.rows[0]!.display_name]);
      }

      let membership = await client.query<{ id: string }>(
        "SELECT id FROM room_members WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 FOR UPDATE",
        [invite.company_id, invite.room_id, principalId],
      );
      let memberId = membership.rows[0]?.id;
      if (memberId) {
        await client.query(
          `UPDATE room_members SET status='active',role=$4,responsibilities='Invited participant',removed_at=NULL
           WHERE company_id=$1 AND room_id=$2 AND principal_id=$3`,
          [invite.company_id, invite.room_id, principalId, invite.role],
        );
      } else {
        memberId = uuidv7();
        await client.query(
          `INSERT INTO room_members(id,company_id,room_id,principal_id,role,responsibilities)
           VALUES($1,$2,$3,$4,$5,'Invited participant')`,
          [memberId, invite.company_id, invite.room_id, principalId, invite.role],
        );
      }

      const room = await client.query<{ room_seq: string }>(
        "UPDATE rooms SET last_event_seq=last_event_seq+1 WHERE company_id=$1 AND id=$2 RETURNING last_event_seq room_seq",
        [invite.company_id, invite.room_id],
      );
      const seq = Number(room.rows[0]!.room_seq), commandId = invite.id;
      await client.query(
        `INSERT INTO room_events(id,company_id,room_id,room_seq,event_type,actor_principal_id,actor_kind,actor_display_name,
          entity_type,entity_id,payload,command_id,correlation_id)
         VALUES($1,$2,$3,$4,'member.joined',$5,'human',$6,'room_member',$7,$8,$9,$9)`,
        [uuidv7(), invite.company_id, invite.room_id, seq, principalId, user.rows[0]!.display_name, memberId,
          { principal_id: principalId, role: invite.role, joined_via_invite: true }, commandId],
      );
      await client.query(
        `UPDATE room_invites SET status='consumed',consumed_at=now(),consumed_by_user_id=$2,consumed_by_principal_id=$3
         WHERE id=$1`, [invite.id, userId, principalId],
      );
      const roomInfo = await client.query<{ room_name: string; company_name: string }>(
        `SELECT r.name room_name,c.name company_name FROM rooms r JOIN companies c ON c.id=r.company_id
         WHERE r.company_id=$1 AND r.id=$2`, [invite.company_id, invite.room_id],
      );
      await client.query("COMMIT");
      return {
        company_id: invite.company_id, room_id: invite.room_id, principal_id: principalId,
        room_name: roomInfo.rows[0]!.room_name, company_name: roomInfo.rows[0]!.company_name,
        room_path: `/rooms/${invite.company_id}/${invite.room_id}`,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
