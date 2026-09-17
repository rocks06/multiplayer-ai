import type { ActionableMarker, RoomEvent, TaskSummary } from "./types.js";

export const DECISION_RESOLUTION_EVENTS = new Set([
  "decision.approved",
  "decision.rejected",
  "decision.cancelled",
  "decision.expired",
]);

export const eventKey = (event: RoomEvent) => String(event.id ?? `room-seq:${event.room_seq}`);

/**
 * Cheap, local first pass: could this event conceivably be this principal's business?
 * Deliberately generous — the authoritative check is relevance, which may read room state.
 */
export function isActionableCandidate(event: RoomEvent, agentPrincipalId: string): boolean {
  if (DECISION_RESOLUTION_EVENTS.has(event.event_type)) return true;
  if (event.actor_principal_id === agentPrincipalId) return false;
  if (event.event_type === "message.sent") return true;
  if (String(event.event_type ?? "").startsWith("task.")) return true;
  return ["human.redirect", "agent.redirected"].includes(event.event_type);
}

export interface RelevanceLookups {
  /** Authorized decision read, used to confirm this principal requested it. */
  getDecision(decisionId: string): Promise<{ requested_by_principal_id?: string } | null>;
  /** Current room tasks, used when a task event's payload carries no assignee. */
  listTasks(): Promise<TaskSummary[]>;
}

/**
 * Does this marker actually require this principal to act? Room isolation depends on this
 * saying no for other principals' work.
 */
export async function isRelevantActionable(
  marker: ActionableMarker,
  agentPrincipalId: string,
  lookups: RelevanceLookups,
): Promise<boolean> {
  if (marker.type === "room.snapshot") return true;
  const event = marker.event;

  if (DECISION_RESOLUTION_EVENTS.has(event.event_type)) {
    const decisionId = (event.payload?.decision_id as string | undefined) ?? event.entity_id;
    if (!decisionId) return false;
    const decision = await lookups.getDecision(decisionId);
    return decision?.requested_by_principal_id === agentPrincipalId;
  }

  if (event.event_type === "message.sent") return messageWakes(event, agentPrincipalId);

  if (String(event.event_type ?? "").startsWith("task.")) {
    const assignee = event.payload?.assignee_principal_id as string | undefined | null;
    // task.created carries the assignee; status changes do not, so fall back to live state.
    if (assignee) return assignee === agentPrincipalId;
    const tasks = await lookups.listTasks();
    const id = event.entity_id ?? (event.payload?.id as string | undefined);
    const task = tasks.find(item => item.id === id);
    return task?.assignee_principal_id === agentPrincipalId;
  }

  const target = (event.payload?.agent_principal_id ?? event.payload?.target_principal_id ?? event.payload?.addressed_principal_id) as string | undefined;
  return target === agentPrincipalId;
}

/**
 * Whether a message is this agent's to act on.
 *
 * The workspace decides and records it on the event as `wake_principal_ids`: sent to this agent,
 * mentioned by structure, or its turn in a bounded collaboration. A message to Everyone is context,
 * not a prompt — no agent replies merely because it was said to the room. One event is one wake, so
 * an agent both sent and mentioned is woken once, and an agent never wakes itself. "@Name" written
 * without a structured mention routes nothing.
 *
 * Events from before the workspace recorded recipients fall back to the same rule from their own
 * fields: addressed or mentioned, and never a broadcast.
 */
export function messageWakes(event: RoomEvent, agentPrincipalId: string): boolean {
  if (event.actor_principal_id === agentPrincipalId) return false;
  const recorded = event.payload?.wake_principal_ids;
  if (Array.isArray(recorded)) return recorded.includes(agentPrincipalId);
  if (event.payload?.addressed_principal_id === agentPrincipalId) return true;
  const mentions = Array.isArray(event.payload?.mentions) ? event.payload!.mentions as Array<{ principal_id?: string }> : [];
  return mentions.some(mention => mention?.principal_id === agentPrincipalId);
}
