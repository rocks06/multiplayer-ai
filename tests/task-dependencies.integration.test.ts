import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { readFile } from "node:fs/promises";
import { buildApp } from "../apps/api/src/app.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for task dependency tests");

describe("Task dependencies", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });
  const asActor = (principalId: string, key: string = crypto.randomUUID()) => ({ "x-principal-id": principalId, "idempotency-key": key });

  async function fixture() {
    const company = (await call("POST", "/v1/companies", { name: "Dep Co" })).json();
    const owner = (await call("POST", `/v1/companies/${company.id}/humans`, { email: `owner-${crypto.randomUUID()}@example.com`, display_name: "Owner" })).json();
    const worker = (await call("POST", `/v1/companies/${company.id}/humans`, { email: `worker-${crypto.randomUUID()}@example.com`, display_name: "Worker" })).json();
    const project = (await call("POST", `/v1/companies/${company.id}/projects`, { name: "P", objective: "O" }, { "x-principal-id": owner.principal_id })).json();
    const room = (await call("POST", `/v1/companies/${company.id}/projects/${project.id}/rooms`, { name: "R", responsibilities: "Own it" }, { "x-principal-id": owner.principal_id })).json();
    await call("POST", `/v1/companies/${company.id}/rooms/${room.id}/members`, { principal_id: worker.principal_id, role: "contributor", responsibilities: "Do it" }, asActor(owner.principal_id, `join-${worker.principal_id}`));
    const base = `/v1/companies/${company.id}/rooms/${room.id}`;
    const task = async (title: string, assignee?: string) =>
      (await call("POST", `${base}/tasks`, { title, description: "", assignee_principal_id: assignee }, asActor(owner.principal_id, `task-${title}-${crypto.randomUUID()}`))).json();
    return { company, owner, worker, room, base, task };
  }

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await bootstrap.query(await readFile("packages/db/schema.sql", "utf8"));
    await bootstrap.query(`TRUNCATE task_dependencies,user_sessions,user_auth_tokens,agent_enrollment_tokens,external_agent_sessions,external_agent_credentials,decisions,agent_tool_calls,agent_runs,command_receipts,room_events,messages,tasks,room_members,rooms,projects,principals,agents,company_users,users,companies CASCADE`);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    app = buildApp(pool, { pollIntervalMs: 50 }, { allowHeaderPrincipal: true });
  });
  afterEach(async () => { await app.close(); });

  it("blocks the normal transition to in_progress while a dependency is incomplete", async () => {
    const f = await fixture();
    const blocker = await f.task("Investigate"), dependent = await f.task("Recommend", f.worker.principal_id);

    expect((await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: blocker.id }, asActor(f.owner.principal_id))).statusCode).toBe(200);

    const refused = await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("task_dependencies_incomplete");
    expect(refused.json().error.details.blocked_by).toEqual([expect.objectContaining({ task_id: blocker.id, status: "open" })]);

    // The refusal is total: the task did not move and its version did not advance.
    const unchanged = await pool.query(`SELECT status,version FROM tasks WHERE id=$1`, [dependent.id]);
    expect(unchanged.rows[0]).toEqual({ status: "open", version: 1 });

    // Completing the blocker releases it, with no override involved.
    await call("PATCH", `${f.base}/tasks/${blocker.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.owner.principal_id));
    await call("PATCH", `${f.base}/tasks/${blocker.id}/status`, { status: "completed", expected_version: 2 }, asActor(f.owner.principal_id));
    expect((await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id))).statusCode).toBe(200);
  });

  it("treats a cancelled dependency as satisfied", async () => {
    const f = await fixture();
    const blocker = await f.task("Abandoned"), dependent = await f.task("Proceed", f.worker.principal_id);
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: blocker.id }, asActor(f.owner.principal_id));
    await call("PATCH", `${f.base}/tasks/${blocker.id}/status`, { status: "cancelled", expected_version: 1 }, asActor(f.owner.principal_id));
    // A cancelled blocker will never arrive, so waiting on it forever would be wrong.
    expect((await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id))).statusCode).toBe(200);
  });

  it("requires a separate audited manager command to bypass, and records who bypassed what", async () => {
    const f = await fixture();
    const blocker = await f.task("Investigate"), dependent = await f.task("Recommend", f.worker.principal_id);
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: blocker.id }, asActor(f.owner.principal_id));

    // A contributor cannot grant themselves a bypass.
    expect((await call("POST", `${f.base}/tasks/${dependent.id}/dependency-override`, { reason: "in a hurry" }, asActor(f.worker.principal_id))).statusCode).toBe(403);

    const key = crypto.randomUUID();
    const granted = await call("POST", `${f.base}/tasks/${dependent.id}/dependency-override`, { reason: "Coleman is unavailable today" }, asActor(f.owner.principal_id, key));
    expect(granted.statusCode).toBe(200);
    expect(granted.json().overridden_dependencies).toEqual([blocker.id]);

    // Idempotent: the same key returns the original result and emits no second event.
    const replayed = await call("POST", `${f.base}/tasks/${dependent.id}/dependency-override`, { reason: "Coleman is unavailable today" }, asActor(f.owner.principal_id, key));
    expect(replayed.json().room_seq).toBe(granted.json().room_seq);

    const events = await pool.query(`SELECT event_type,actor_principal_id,payload FROM room_events WHERE room_id=$1 AND event_type='task.dependency_override_granted'`, [f.room.id]);
    expect(events.rowCount).toBe(1);
    expect(events.rows[0].actor_principal_id).toBe(f.owner.principal_id);
    expect(events.rows[0].payload.reason).toBe("Coleman is unavailable today");

    expect((await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id))).statusCode).toBe(200);
  });

  it("retires an override when a new dependency is added", async () => {
    const f = await fixture();
    const first = await f.task("First"), second = await f.task("Second"), dependent = await f.task("Recommend", f.worker.principal_id);
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: first.id }, asActor(f.owner.principal_id));
    await call("POST", `${f.base}/tasks/${dependent.id}/dependency-override`, { reason: "proceed" }, asActor(f.owner.principal_id));

    // A bypass granted against one blocker must not silently cover a later one.
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: second.id }, asActor(f.owner.principal_id));
    const refused = await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id));
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe("task_dependencies_incomplete");
  });

  it("rejects self-dependency, reciprocal pairs, unknown tasks, and pointless overrides", async () => {
    const f = await fixture();
    const a = await f.task("A"), b = await f.task("B");
    expect((await call("POST", `${f.base}/tasks/${a.id}/dependencies`, { depends_on_task_id: a.id }, asActor(f.owner.principal_id))).json().error.code).toBe("invalid_task_dependency");
    await call("POST", `${f.base}/tasks/${a.id}/dependencies`, { depends_on_task_id: b.id }, asActor(f.owner.principal_id));
    // B depending back on A would deadlock both behind each other.
    expect((await call("POST", `${f.base}/tasks/${b.id}/dependencies`, { depends_on_task_id: a.id }, asActor(f.owner.principal_id))).json().error.code).toBe("invalid_task_dependency");
    expect((await call("POST", `${f.base}/tasks/${a.id}/dependencies`, { depends_on_task_id: crypto.randomUUID() }, asActor(f.owner.principal_id))).statusCode).toBe(404);
    expect((await call("POST", `${f.base}/tasks/${b.id}/dependency-override`, { reason: "nothing to bypass" }, asActor(f.owner.principal_id))).json().error.code).toBe("no_incomplete_dependencies");
    expect((await call("DELETE", `${f.base}/tasks/${a.id}/dependencies/${crypto.randomUUID()}`, undefined, asActor(f.owner.principal_id))).statusCode).toBe(404);
  });

  it("keeps optimistic concurrency ahead of the dependency guard", async () => {
    const f = await fixture();
    const blocker = await f.task("Investigate"), dependent = await f.task("Recommend", f.worker.principal_id);
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: blocker.id }, asActor(f.owner.principal_id));

    // A stale version is still a version conflict, not a dependency error: the pre-existing
    // Phase 1A invariant keeps precedence over the new one.
    const stale = await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 99 }, asActor(f.worker.principal_id));
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe("version_conflict");

    // An invalid transition is still an invalid transition.
    await call("PATCH", `${f.base}/tasks/${blocker.id}/status`, { status: "cancelled", expected_version: 1 }, asActor(f.owner.principal_id));
    await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "cancelled", expected_version: 1 }, asActor(f.owner.principal_id));
    const terminal = await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 2 }, asActor(f.worker.principal_id));
    expect(terminal.json().error.code).toBe("invalid_task_transition");
  });

  it("serialises a dependency added concurrently with a transition", async () => {
    const f = await fixture();
    const blocker = await f.task("Investigate"), dependent = await f.task("Recommend", f.worker.principal_id);

    // Racing an add against a start must never leave a task running with an unmet dependency.
    const [added, started] = await Promise.all([
      call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: blocker.id }, asActor(f.owner.principal_id)),
      call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id)),
    ]);
    expect(added.statusCode).toBe(200);

    const finalState = await pool.query(`SELECT status FROM tasks WHERE id=$1`, [dependent.id]);
    const outstanding = await pool.query(`SELECT count(*)::int n FROM task_dependencies d JOIN tasks t ON t.id=d.depends_on_task_id WHERE d.task_id=$1 AND t.status NOT IN ('completed','cancelled')`, [dependent.id]);
    // Either the start won and the dependency landed after it, or the guard refused the start.
    // What must never happen is a refused start that still moved the task.
    if (started.statusCode !== 200) {
      expect(started.json().error.code).toBe("task_dependencies_incomplete");
      expect(finalState.rows[0].status).toBe("open");
    }
    expect(outstanding.rows[0].n).toBe(1);
  });

  it("exposes only incomplete blockers in the room snapshot", async () => {
    const f = await fixture();
    const done = await f.task("Done"), pending = await f.task("Pending"), dependent = await f.task("Recommend", f.worker.principal_id);
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: done.id }, asActor(f.owner.principal_id));
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: pending.id }, asActor(f.owner.principal_id));
    await call("PATCH", `${f.base}/tasks/${done.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.owner.principal_id));
    await call("PATCH", `${f.base}/tasks/${done.id}/status`, { status: "completed", expected_version: 2 }, asActor(f.owner.principal_id));

    const snapshot = (await call("GET", `${f.base}/snapshot`, undefined, { "x-principal-id": f.owner.principal_id })).json();
    const shown = snapshot.tasks.find((t: any) => t.id === dependent.id);
    expect(shown.blocked_by).toEqual([expect.objectContaining({ task_id: pending.id })]);
    expect(snapshot.tasks.find((t: any) => t.id === pending.id).blocked_by).toEqual([]);
  });

  it("removes a dependency and records both edges as events", async () => {
    const f = await fixture();
    const blocker = await f.task("Investigate"), dependent = await f.task("Recommend", f.worker.principal_id);
    await call("POST", `${f.base}/tasks/${dependent.id}/dependencies`, { depends_on_task_id: blocker.id }, asActor(f.owner.principal_id));
    expect((await call("DELETE", `${f.base}/tasks/${dependent.id}/dependencies/${blocker.id}`, undefined, asActor(f.owner.principal_id))).statusCode).toBe(200);
    expect((await call("PATCH", `${f.base}/tasks/${dependent.id}/status`, { status: "in_progress", expected_version: 1 }, asActor(f.worker.principal_id))).statusCode).toBe(200);

    const events = await pool.query(`SELECT event_type FROM room_events WHERE room_id=$1 AND event_type LIKE 'task.dependency%' ORDER BY room_seq`, [f.room.id]);
    expect(events.rows.map(r => r.event_type)).toEqual(["task.dependency_added", "task.dependency_removed"]);
  });
});
