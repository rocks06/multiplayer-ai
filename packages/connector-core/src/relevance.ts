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

/**
 * Whether this wake makes the agent a collaboration contributor rather than the one producing the
 * result. Two agents collaborating each delivered their own final file; the collaboration's lead
 * produces the single agreed result, and other participants contribute in the conversation.
 *
 * A contributor is an agent woken into a collaboration still going that someone else leads —
 * including when a person started it by mentioning this agent alongside others, which is exactly
 * when both agents used to publish. The workspace refuses a contributor's files while the
 * collaboration runs, so this only tells the agent in advance what it would be told anyway.
 */
export function collaborationContributor(trigger: Array<{ type: string; event?: RoomEvent }>, agentPrincipalId: string): boolean {
  const ongoing = trigger
    .filter(marker => marker.type === "room.event" && marker.event?.event_type === "message.sent")
    .map(marker => marker.event!.payload?.collaboration as { lead_principal_id?: string; status?: string } | undefined | null)
    .filter(collaboration => collaboration?.lead_principal_id && ["active", "waiting_for_human", undefined].includes(collaboration.status));
  if (!ongoing.length) return false;
  return ongoing.every(collaboration => collaboration!.lead_principal_id !== agentPrincipalId);
}
