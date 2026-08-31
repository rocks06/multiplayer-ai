import fs from "node:fs";
import path from "node:path";
import type { ConnectorState, StateStore } from "./types.js";

export const emptyState = (): ConnectorState => ({
  last_contiguous_seq: null,
  processed_event_ids: [],
  pending_actionable_events: [],
});

/**
 * Whether durable state may be reused for this agent in this room.
 *
 * A session belongs to one agent in one room, and so does the contiguous cursor. State naming a
 * different pair is left over from a binding the machine no longer has: adopting it would
 * connect the new agent to the old agent's room, quietly, with every health indicator reading
 * normally. State that names neither is from a build that predates these fields and is trusted,
 * because it can only have come from the one binding that machine had.
 */
export const belongsTo = (state: ConnectorState, roomId: string, agentPrincipalId: string): boolean => {
  const sameRoom = state.room_id === undefined || state.room_id === roomId;
  const sameAgent = state.agent_principal_id === undefined || state.agent_principal_id === agentPrincipalId;
  return sameRoom && sameAgent;
};

/**
 * Durable state on the local filesystem, written 0600 through a temp file and rename so a
 * crash mid-write cannot leave a truncated cursor or a half-written marker list behind.
 */
export class FileStateStore implements StateStore {
  constructor(private readonly file: string) {}

  load(): ConnectorState {
    let parsed: Partial<ConnectorState> = {};
    if (fs.existsSync(this.file)) {
      try { parsed = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch { parsed = {}; }
    }
    return {
      ...emptyState(),
      ...parsed,
      // Older builds predate these fields; normalise rather than trusting the file's shape.
      processed_event_ids: Array.isArray(parsed.processed_event_ids) ? parsed.processed_event_ids : [],
      pending_actionable_events: Array.isArray(parsed.pending_actionable_events) ? parsed.pending_actionable_events : [],
      last_contiguous_seq: parsed.last_contiguous_seq ?? null,
    };
  }

  save(state: ConnectorState) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
    fs.chmodSync(temp, 0o600);
    fs.renameSync(temp, this.file);
  }
}

/** In-memory store for tests and for hosts that persist state themselves. */
export class MemoryStateStore implements StateStore {
  constructor(private state: ConnectorState = emptyState()) {}
  load() { return this.state; }
  save(state: ConnectorState) { this.state = state; }
}
