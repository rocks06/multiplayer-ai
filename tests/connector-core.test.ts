import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  needsRestart,
  eventKey,
  isActionableCandidate,
  isRelevantActionable,
  taskStepKey,
  WORKFLOW_STEPS,
  belongsTo,
  emptyState,
  ConnectorRuntime,
  MemoryStateStore,
  type ActionableMarker,
  type RoomEvent,
  type TaskSummary,
} from "../packages/connector-core/src/index.js";

const ME = "00000000-0000-4000-8000-00000000000a";
const PEER = "00000000-0000-4000-8000-00000000000b";
const HUMAN = "00000000-0000-4000-8000-00000000000c";
const TASK_A = "00000000-0000-4000-8000-0000000000a1";
const TASK_B = "00000000-0000-4000-8000-0000000000b1";
const DECISION = "00000000-0000-4000-8000-0000000000d1";

const marker = (event: RoomEvent): ActionableMarker => ({ key: eventKey(event), type: "room.event", event });
const lookups = (tasks: TaskSummary[] = [], decision: { requested_by_principal_id?: string } | null = null) => ({
  getDecision: async () => decision,
  listTasks: async () => tasks,
});

describe("connector relevance", () => {
  it("wakes on a task created already assigned to this principal", async () => {
    const event: RoomEvent = { id: "e1", room_seq: 11, event_type: "task.created", actor_principal_id: HUMAN, actor_kind: "human", entity_id: TASK_A, payload: { id: TASK_A, assignee_principal_id: ME, status: "open", version: 1 } };
    expect(isActionableCandidate(event, ME)).toBe(true);
    expect(await isRelevantActionable(marker(event), ME, lookups())).toBe(true);
  });

  it("stays out of another principal's assigned work", async () => {
    const event: RoomEvent = { id: "e2", room_seq: 11, event_type: "task.created", actor_principal_id: HUMAN, actor_kind: "human", entity_id: TASK_B, payload: { id: TASK_B, assignee_principal_id: PEER, status: "open", version: 1 } };
    expect(await isRelevantActionable(marker(event), ME, lookups())).toBe(false);
  });

  it("resolves a status change with no assignee in the payload against live room state", async () => {
    const event: RoomEvent = { id: "e3", room_seq: 12, event_type: "task.blocked", actor_principal_id: HUMAN, actor_kind: "human", entity_id: TASK_A, payload: { id: TASK_A, status: "blocked", version: 4 } };
    const mine: TaskSummary[] = [{ id: TASK_A, status: "blocked", version: 4, assignee_principal_id: ME }];
    const theirs: TaskSummary[] = [{ id: TASK_A, status: "blocked", version: 4, assignee_principal_id: PEER }];
    expect(await isRelevantActionable(marker(event), ME, lookups(mine))).toBe(true);
    expect(await isRelevantActionable(marker(event), ME, lookups(theirs))).toBe(false);
  });

  it("wakes only on decisions this principal requested", async () => {
    const event: RoomEvent = { id: "e4", room_seq: 13, event_type: "decision.approved", actor_principal_id: HUMAN, actor_kind: "human", entity_id: DECISION, payload: { decision_id: DECISION, status: "approved" } };
    expect(await isRelevantActionable(marker(event), ME, lookups([], { requested_by_principal_id: ME }))).toBe(true);
    expect(await isRelevantActionable(marker(event), ME, lookups([], { requested_by_principal_id: PEER }))).toBe(false);
  });

  it("separates addressed messages, human broadcasts, and other agents' traffic", async () => {
    const addressed: RoomEvent = { id: "e5", room_seq: 14, event_type: "message.sent", actor_principal_id: PEER, actor_kind: "agent", payload: { addressed_principal_id: ME } };
    const broadcast: RoomEvent = { id: "e6", room_seq: 15, event_type: "message.sent", actor_principal_id: HUMAN, actor_kind: "human", payload: {} };
    const elsewhere: RoomEvent = { id: "e7", room_seq: 16, event_type: "message.sent", actor_principal_id: PEER, actor_kind: "agent", payload: { addressed_principal_id: PEER } };
    expect(await isRelevantActionable(marker(addressed), ME, lookups())).toBe(true);
    expect(await isRelevantActionable(marker(broadcast), ME, lookups())).toBe(true);
    expect(await isRelevantActionable(marker(elsewhere), ME, lookups())).toBe(false);
  });

  it("never wakes a principal on its own actions", () => {
    const own: RoomEvent = { id: "e8", room_seq: 17, event_type: "task.in_progress", actor_principal_id: ME, actor_kind: "agent", entity_id: TASK_A, payload: { id: TASK_A } };
    expect(isActionableCandidate(own, ME)).toBe(false);
  });

  it("always treats a snapshot as actionable, since the cursor was discarded", async () => {
    expect(await isRelevantActionable({ key: "room.snapshot:10", type: "room.snapshot", snapshot_seq: 10 }, ME, lookups())).toBe(true);
  });
});

describe("idempotency keys", () => {
  it("is stable per task and step, and never collides across tasks", () => {
    expect(taskStepKey("jj", TASK_A, "start")).toBe(taskStepKey("jj", TASK_A, "start"));
    const a = new Set(WORKFLOW_STEPS.map(step => taskStepKey("jj", TASK_A, step)));
    const b = new Set(WORKFLOW_STEPS.map(step => taskStepKey("jj", TASK_B, step)));
    expect(a.size).toBe(WORKFLOW_STEPS.length);
    expect([...a].filter(key => b.has(key))).toEqual([]);
  });

  it("scopes keys per profile so two runtimes cannot collide", () => {
    expect(taskStepKey("jj", TASK_A, "start")).not.toBe(taskStepKey("coleman", TASK_A, "start"));
  });
});

describe("adapter boundary", () => {
  it("keeps agent-runtime specifics out of the connector core", () => {
    const dir = new URL("../packages/connector-core/src/", import.meta.url);
    const offenders: string[] = [];
    for (const file of readdirSync(dir)) {
      const source = readFileSync(new URL(file, dir), "utf8");
      for (const line of source.split("\n")) {
        // Field names carried over from the bridge's state file are allowed; imports are not.
        if (/^\s*import\b/.test(line) && /connector-hermes|hermes/i.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * A session belongs to one agent in one room.
 *
 * Durable state that names a different pair is left over from a binding this machine no longer
 * has. Reusing it would open the new agent onto the old agent's room with everything looking
 * healthy — which is exactly what happened the first time one machine was bound twice.
 */
describe("durable state ownership", () => {
  const state = { ...emptyState(), session_id: "s1", session_token: "t1", room_id: "room-a", agent_principal_id: "agent-a" };

  it("is reused for the same agent in the same room", () => {
    expect(belongsTo(state, "room-a", "agent-a")).toBe(true);
  });

  it("is refused for a different room", () => {
    expect(belongsTo(state, "room-b", "agent-a")).toBe(false);
  });

  it("is refused for a different agent", () => {
    expect(belongsTo(state, "room-a", "agent-b")).toBe(false);
  });

  it("trusts state from a build that predates these fields", () => {
    expect(belongsTo(emptyState(), "room-a", "agent-a")).toBe(true);
  });
});

/**
 * A runtime defends its own room.
 *
 * The host stops the old runtime before configuring the new one, but stopping is asynchronous:
 * the old runtime can still write its state after the host has cleared it, and the next runtime
 * then reads exactly what the host thought it had removed. Adopting that session would put the
 * new agent into the old agent's room, connected and healthy-looking, and it did — about one
 * binding in three — until this check moved inside the runtime where nothing can race it.
 */
describe("a runtime built on another binding's durable state", () => {
  const room = "11111111-1111-4111-8111-111111111111";
  const agent = "22222222-2222-4222-8222-222222222222";
  const build = (state: Record<string, unknown>) => {
    const store = new MemoryStateStore({ ...emptyState(), ...state } as never);
    const runtime = new ConnectorRuntime({
      config: { baseUrl: "http://workspace.invalid", roomId: room, agentPrincipalId: agent, credential: "c" },
      profile: "test", store, adapter: {} as never,
      commandSurface: { template: "x COMMAND", verbs: [] }, logPath: "/dev/null",
    });
    return { runtime, store };
  };

  it("starts clean rather than adopting a session from another room", () => {
    const { runtime } = build({
      session_id: "old", session_token: "t", room_id: "33333333-3333-4333-8333-333333333333",
      agent_principal_id: agent, last_contiguous_seq: 42,
    });
    expect(runtime.snapshotState.session_id).toBeUndefined();
    // The cursor counted events in a room this agent is not in, so it goes too.
    expect(runtime.snapshotState.last_contiguous_seq).toBeNull();
    expect(runtime.snapshotState.room_id).toBe(room);
  });

  it("starts clean rather than adopting a session belonging to another agent", () => {
    const { runtime } = build({
      session_id: "old", session_token: "t", room_id: room,
      agent_principal_id: "44444444-4444-4444-8444-444444444444",
    });
    expect(runtime.snapshotState.session_id).toBeUndefined();
    expect(runtime.snapshotState.agent_principal_id).toBe(agent);
  });

  it("keeps its own session, so a restart still resumes rather than starting over", () => {
    const { runtime } = build({
      session_id: "mine", session_token: "t", room_id: room,
      agent_principal_id: agent, last_contiguous_seq: 7,
    });
    expect(runtime.snapshotState.session_id).toBe("mine");
    expect(runtime.snapshotState.last_contiguous_seq).toBe(7);
  });
});

/**
 * When the sidecar must tear the runtime down instead of leaving it running.
 *
 * The credential clause is the one that was missing. `configure` compared only the room and the
 * agent, so a rebind in the same room updated the stored config and left the live runtime holding
 * the previous credential — which minting the new one had just retired. It authenticated with a
 * dead key until something gave up, and the Mac reported that its access had been removed seconds
 * after it had successfully connected.
 */
describe("deciding whether a reconfiguration restarts the runtime", () => {
  const config = { roomId: "room-1", agentPrincipalId: "jj", credential: "magc_one" };

  it("leaves an unchanged configuration alone", () => {
    expect(needsRestart(config, { ...config })).toBe(false);
  });

  it("restarts when the credential has been replaced", () => {
    expect(needsRestart(config, { ...config, credential: "magc_two" })).toBe(true);
  });

  it("restarts for a different room or a different agent", () => {
    expect(needsRestart(config, { ...config, roomId: "room-2" })).toBe(true);
    expect(needsRestart(config, { ...config, agentPrincipalId: "coleman" })).toBe(true);
  });

  it("has nothing to restart before anything is configured", () => {
    expect(needsRestart(null, config)).toBe(false);
    expect(needsRestart(undefined, config)).toBe(false);
  });
});
