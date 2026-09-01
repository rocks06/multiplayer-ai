import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { RoomInviteService } from "../apps/api/src/invites/room-invite-service.js";
import { RoomService } from "../apps/api/src/room-service.js";
import { DomainError } from "../packages/domain/src/index.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";
import { truncateAll } from "./support/database.js";

const connectionString = process.env.DATABASE_URL!;
const pool = new pg.Pool({ connectionString });
const roomService = new RoomService(pool);
const invites = new RoomInviteService(pool);

describe("secure room invitations", () => {
  beforeEach(async () => truncateAll(pool));
  afterAll(async () => pool.end());

  async function setup() {
    const company = await seedCompany(pool,"Test");
    const human = await seedHuman(pool,company.id,"owner@example.test","Owner");
    const project = await roomService.createProject(company.id,human.principal_id,"Project","Objective");
    const room = await roomService.createRoom(company.id,project.id,human.principal_id,"Main","Manage");
    const user = await pool.query<{id:string}>(
      `INSERT INTO users(id,email,display_name) VALUES(gen_random_uuid(),'second@example.test','Second Human') RETURNING id`,
    );
    return {companyId:company.id,humanId:human.principal_id,roomId:room.id,invitedUserId:user.rows[0]!.id};
  }

  it("stores only a hash and atomically grants room-only company scaffolding and room membership", async () => {
    const x = await setup();
    const invite = await invites.issue({companyId:x.companyId,roomId:x.roomId,actorId:x.humanId,ttlHours:2});
    expect(invite.invite_token).toMatch(/^mpri_/);
    expect(invite.invite_path).toBe(`/join#${invite.invite_token}`);

    const stored = await pool.query<{token_hash:string;token_prefix:string}>("SELECT token_hash,token_prefix FROM room_invites WHERE id=$1",[invite.id]);
    expect(stored.rows[0]!.token_hash).not.toContain(invite.invite_token);
    expect(stored.rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored.rows[0])).not.toContain(invite.invite_token);

    const preview = await invites.preview(invite.invite_token);
    expect(preview).toMatchObject({company_name:"Test",room_name:"Main"});
    expect(preview).not.toHaveProperty("company_id");
    expect(preview).not.toHaveProperty("members");

    const accepted = await invites.accept(invite.invite_token,x.invitedUserId);
    expect(accepted.room_path).toBe(`/rooms/${x.companyId}/${x.roomId}`);
    const membership = await pool.query(
      `SELECT rm.role,rm.status,p.user_id,cu.status company_status,cu.access_scope FROM room_members rm
       JOIN principals p ON p.company_id=rm.company_id AND p.id=rm.principal_id
       JOIN company_users cu ON cu.company_id=p.company_id AND cu.user_id=p.user_id
       WHERE rm.company_id=$1 AND rm.room_id=$2 AND p.user_id=$3`,
      [x.companyId,x.roomId,x.invitedUserId],
    );
    expect(membership.rows[0]).toMatchObject({role:"contributor",status:"active",company_status:"active",access_scope:"room_only"});
    const event = await pool.query("SELECT event_type,actor_principal_id,payload FROM room_events WHERE company_id=$1 AND room_id=$2 ORDER BY room_seq DESC LIMIT 1",[x.companyId,x.roomId]);
    expect(event.rows[0]).toMatchObject({event_type:"member.joined",actor_principal_id:accepted.principal_id});
    expect(event.rows[0]!.payload).toMatchObject({joined_via_invite:true});
    await expect(invites.accept(invite.invite_token,x.invitedUserId)).rejects.toMatchObject({code:"room_invite_invalid"});
  });

  it("rejects guessed, expired, and non-manager issuance", async () => {
    const x = await setup();
    await expect(invites.preview("mpri_not-a-real-random-invite-secret")).rejects.toMatchObject({code:"room_invite_invalid"});
    const invite = await invites.issue({companyId:x.companyId,roomId:x.roomId,actorId:x.humanId,ttlHours:1});
    await pool.query("UPDATE room_invites SET expires_at=now()-interval '1 second' WHERE id=$1",[invite.id]);
    await expect(invites.accept(invite.invite_token,x.invitedUserId)).rejects.toMatchObject({code:"room_invite_invalid"});

    const human = await roomService.createHuman(x.companyId,"third@example.test","Third Human");
    await roomService.addMember({companyId:x.companyId,roomId:x.roomId,actorId:x.humanId,principalId:human.principal_id,role:"contributor",responsibilities:"Review",idempotencyKey:"add-third"});
    await expect(invites.issue({companyId:x.companyId,roomId:x.roomId,actorId:human.principal_id})).rejects.toMatchObject({code:"permission_denied"});
  });

  it("allows only one winner under concurrent redemption", async () => {
    const x = await setup();
    const invite = await invites.issue({companyId:x.companyId,roomId:x.roomId,actorId:x.humanId});
    const results = await Promise.allSettled([
      invites.accept(invite.invite_token,x.invitedUserId),
      invites.accept(invite.invite_token,x.invitedUserId),
    ]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const rejection = results.find(r=>r.status==="rejected") as PromiseRejectedResult;
    expect(rejection.reason).toBeInstanceOf(DomainError);
    expect(rejection.reason.code).toBe("room_invite_invalid");
    const members = await pool.query("SELECT count(*)::int count FROM room_members rm JOIN principals p ON p.company_id=rm.company_id AND p.id=rm.principal_id WHERE rm.company_id=$1 AND rm.room_id=$2 AND p.user_id=$3",[x.companyId,x.roomId,x.invitedUserId]);
    expect(members.rows[0].count).toBe(1);
  });
});
