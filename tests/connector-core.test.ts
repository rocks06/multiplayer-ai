import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  eventKey,
  isActionableCandidate,
  isRelevantActionable,
  taskStepKey,
  WORKFLOW_STEPS,
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
