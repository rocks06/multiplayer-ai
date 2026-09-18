import type { CapabilityState } from "./capabilities.js";

/**
 * What an agent is shown of its room, and nothing more.
 *
 * Every path that gives an agent room context — the gateway snapshot, the realtime stream's
 * snapshot and events, the in-process worker — passes through here, so there is one definition of
 * what an agent may see rather than four that drift. It is a projection of the room: the
 * conversation, its tasks, its decisions and the people and agents in it. It is never other rooms,
 * other workspaces, anybody's reading habits, session or credential identifiers, or where some
 * other agent happens to be connected — each of which the room snapshot used to hand over.
 */

/** Keys that identify a session, a credential or another place, at any depth. */
const INTERNAL_KEY = /(^|_)(session_id|replaced_by|moved_from_room_id|credential_id|token|token_hash|session_token|email)$/i;

/** Connection bookkeeping. Kept in the stream as a placeholder, because a missing sequence number
 *  would read to a connector as lost events and send it into a resync loop — but emptied. */
const CONNECTION_EVENTS = new Set([
  "agent.session.connected", "agent.session.moved", "agent.session.superseded", "agent.session.disconnected",
  "agent.reconnected", "agent.woke", "agent.idle",
]);

function strip(value: unknown, depth = 0): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map(item => strip(item, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (INTERNAL_KEY.test(key)) continue;
      out[key] = strip(item, depth + 1);
    }
    return out;
  }
  return value;
}

/** One room event as an agent may receive it. Same sequence number, never more than it needs. */
export function eventForAgent<T extends { event_type: string; payload?: unknown }>(event: T): T {
  if (CONNECTION_EVENTS.has(event.event_type)) return { ...event, payload: {} };
  return { ...event, payload: strip(event.payload ?? {}) } as T;
}

const memberForAgent = (member: any) => ({
  principal_id: member.principal_id, display_name: member.display_name, kind: member.kind,
  role: member.role, responsibilities: member.responsibilities,
  ...(member.kind === "agent" ? {
    agent_presence: member.agent_presence ?? null, agent_runtime_status: member.agent_runtime_status ?? null,
  } : {}),
});

/**
 * The room as an agent sees it. `capabilities` is included so the agent's runtime can say truthfully
 * what it may do; it is guidance for the agent, and enforcement happens on every request regardless.
 */
export function roomContextForAgent(snapshot: any, capabilities: CapabilityState[]) {
  const briefing = snapshot.briefing ?? {};
  return {
    room: snapshot.room,
    snapshot_seq: snapshot.snapshot_seq,
    members: (snapshot.members ?? []).map(memberForAgent),
    tasks: snapshot.tasks ?? [],
    messages: (snapshot.messages ?? []).map((message: any) => ({
      ...message,
      attachments: (message.attachments ?? []).map((a: any) => ({
        id: a.id, filename: a.filename, content_type: a.content_type, byte_size: a.byte_size,
      })),
    })),
    recent_events: (snapshot.recent_events ?? []).map(eventForAgent),
    briefing: {
      ...briefing,
      participants: (briefing.participants ?? []).map(memberForAgent),
      important_recent_activity: (briefing.important_recent_activity ?? []).map(eventForAgent),
    },
    relationships: snapshot.relationships ?? [],
    capabilities: {
      granted: capabilities.filter(state => state.allowed).map(state => state.capability),
      denied: capabilities.filter(state => !state.allowed).map(state => state.capability),
    },
    context_scope: "this_room_only",
  };
}
