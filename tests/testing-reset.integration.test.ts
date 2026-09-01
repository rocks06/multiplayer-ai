import { afterAll, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { RoomService } from "../apps/api/src/room-service.js";
import { resetTestingWorkspace } from "../packages/testing-reset/src/index.js";
import { truncateAll } from "./support/database.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for testing reset tests");
const pool = new pg.Pool({ connectionString });
const service = new RoomService(pool);

async function world() {
  const testing = await seedCompany(pool, "TESTING");
  const manager = await seedHuman(pool, testing.id, "manager@example.com", "Manager");
  const second = await seedHuman(pool, testing.id, "second@example.com", "Second");
  const keepA = await service.createAgent(testing.id, manager.user_id, "Coleman");
  const keepB = await service.createAgent(testing.id, second.user_id, "JJ");
  const duplicate = await service.createAgent(testing.id, second.user_id, "JJ debug");
  const project = await service.createProject(testing.id, manager.principal_id, "Old", "Old objective");
  const room = await service.createRoom(testing.id, project.id, manager.principal_id, "roomr", "Manager");
  for (const principalId of [second.principal_id, keepA.principal_id, keepB.principal_id, duplicate.principal_id]) {
    await service.addMember({
      companyId: testing.id, roomId: room.id, actorId: manager.principal_id, principalId,
      role: principalId === second.principal_id ? "contributor" : "worker_agent",
      responsibilities: "Old", idempotencyKey: crypto.randomUUID(),
    });
  }
  await service.sendMessage({ companyId: testing.id, roomId: room.id, actorId: manager.principal_id, body: "debug", idempotencyKey: crypto.randomUUID() });
  await service.createTask({ companyId: testing.id, roomId: room.id, actorId: manager.principal_id, title: "debug", description: "debug", assigneePrincipalId: duplicate.principal_id, idempotencyKey: crypto.randomUUID() });

  const other = await seedCompany(pool, "PRODUCTION VERIFICATION");
  const outsider = await seedHuman(pool, other.id, "safe@example.com", "Safe");
  const otherProject = await service.createProject(other.id, outsider.principal_id, "Keep", "Keep");
  const otherRoom = await service.createRoom(other.id, otherProject.id, outsider.principal_id, "Keep room", "Keep");

  return { testing, manager, second, keepA, keepB, duplicate, room, other, outsider, otherRoom };
}

const inputFor = (w: Awaited<ReturnType<typeof world>>, apply = false) => ({
  companyId: w.testing.id,
  managerPrincipalId: w.manager.principal_id,
  humanPrincipalIds: [w.second.principal_id],
  agentPrincipalIds: [w.keepA.principal_id, w.keepB.principal_id],
  roomName: "Acceptance Room",
  apply,
});

describe("scoped TESTING reset", () => {
  beforeEach(async () => { await truncateAll(pool); });
  afterAll(async () => { await pool.end(); });

  it("is a rolled-back dry run by default", async () => {
    const w = await world();
    const plan = await resetTestingWorkspace(pool, inputFor(w));
    expect(plan.mode).toBe("dry_run");
    expect(plan.remove.rooms).toBe(1);
    expect(plan.remove.unprotected_agent_principals).toBe(1);
    expect(plan.created).toBeNull();
    expect((await pool.query("SELECT name FROM rooms WHERE id=$1", [w.room.id])).rows[0]?.name).toBe("roomr");
    expect((await pool.query("SELECT 1 FROM principals WHERE id=$1", [w.duplicate.principal_id])).rowCount).toBe(1);
  });

  it("preserves named humans and physical agents, removes debug state, and creates one clean room", async () => {
    const w = await world();
    const result = await resetTestingWorkspace(pool, inputFor(w, true));
    expect(result.mode).toBe("applied");
    expect(result.created?.room_name).toBe("Acceptance Room");

    const rooms = await pool.query("SELECT id,name FROM rooms WHERE company_id=$1", [w.testing.id]);
    expect(rooms.rows).toEqual([{ id: result.created!.room_id, name: "Acceptance Room" }]);
    const members = await pool.query("SELECT principal_id,role FROM room_members WHERE room_id=$1 ORDER BY role,principal_id", [result.created!.room_id]);
    expect(members.rows).toHaveLength(4);
    expect(new Set(members.rows.map(row => row.principal_id))).toEqual(new Set([
      w.manager.principal_id, w.second.principal_id, w.keepA.principal_id, w.keepB.principal_id,
    ]));
    expect((await pool.query("SELECT 1 FROM principals WHERE id=$1", [w.duplicate.principal_id])).rowCount).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM tasks WHERE company_id=$1", [w.testing.id])).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM messages WHERE company_id=$1", [w.testing.id])).rows[0].count).toBe(0);

    // The unrelated workspace and its verification room are byte-for-byte outside reset scope.
    expect((await pool.query("SELECT name FROM companies WHERE id=$1", [w.other.id])).rows[0].name).toBe("PRODUCTION VERIFICATION");
    expect((await pool.query("SELECT name FROM rooms WHERE id=$1", [w.otherRoom.id])).rows[0].name).toBe("Keep room");
    expect((await pool.query("SELECT 1 FROM principals WHERE id=$1", [w.outsider.principal_id])).rowCount).toBe(1);
  });

  it("refuses every workspace not named exactly TESTING and invalid protected ids", async () => {
    const w = await world();
    await expect(resetTestingWorkspace(pool, { ...inputFor(w, true), companyId: w.other.id })).rejects.toMatchObject({ code: "testing_reset_workspace_refused" });
    await expect(resetTestingWorkspace(pool, { ...inputFor(w, true), agentPrincipalIds: [w.duplicate.principal_id, w.outsider.principal_id] })).rejects.toMatchObject({ code: "testing_reset_agent_invalid" });
    expect((await pool.query("SELECT name FROM rooms WHERE id=$1", [w.room.id])).rowCount).toBe(1);
  });
});
