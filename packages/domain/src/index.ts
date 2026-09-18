export type PrincipalKind = "human" | "agent" | "system";
export type RoomRole = "manager" | "contributor" | "worker_agent";
export type TaskStatus = "open" | "in_progress" | "blocked" | "awaiting_decision" | "completed" | "cancelled";

export type Permission =
  | "room.read"
  | "message.send"
  | "task.create"
  | "task.update.own"
  | "task.update.any"
  | "member.manage"
  | "decision.request"
  | "decision.resolve";

export const ROLE_PERMISSIONS: Record<RoomRole, ReadonlySet<Permission>> = {
  manager: new Set<Permission>(["room.read", "message.send", "task.create", "task.update.own", "task.update.any", "member.manage", "decision.resolve"]),
  contributor: new Set<Permission>(["room.read", "message.send", "task.create", "task.update.own"]),
  worker_agent: new Set<Permission>(["room.read", "message.send", "task.update.own", "decision.request"]),
};

export function roleHasPermission(role: RoomRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

export const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  open: new Set<TaskStatus>(["in_progress", "cancelled"]),
  in_progress: new Set<TaskStatus>(["blocked", "awaiting_decision", "completed", "cancelled"]),
  blocked: new Set<TaskStatus>(["in_progress", "cancelled"]),
  awaiting_decision: new Set<TaskStatus>(["in_progress", "cancelled"]),
  completed: new Set<TaskStatus>(),
  cancelled: new Set<TaskStatus>(),
};

export function canTransitionTask(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].has(to);
}

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode: number,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/**
 * What an agent may do, named — provider-independent, and decided by the platform rather than by
 * anything an agent was told.
 *
 * `server` capabilities are enforced by the workspace itself on every request, whatever runtime
 * the agent uses. `local_broker` capabilities concern the agent's own machine — files, processes,
 * the network — and are enforced by the connector's broker; until that broker exists they are
 * recorded but NOT enforced, and every surface that lists them must say so rather than implying a
 * protection that is not there.
 */
export const AGENT_CAPABILITIES = [
  "read_room_messages", "write_room_messages", "mention_participants", "invoke_agent",
  "update_tasks", "request_decision", "create_artifacts", "read_room_files",
  "use_web", "read_local_files", "write_local_files", "execute_code",
  "call_external_api", "send_external_message", "perform_sensitive_action",
] as const;
export type AgentCapability = typeof AGENT_CAPABILITIES[number];

export const CAPABILITY_ENFORCEMENT: Record<AgentCapability, "server" | "local_broker"> = {
  read_room_messages: "server", write_room_messages: "server", mention_participants: "server",
  invoke_agent: "server", update_tasks: "server", request_decision: "server",
  create_artifacts: "server", read_room_files: "server",
  use_web: "local_broker", read_local_files: "local_broker", write_local_files: "local_broker",
  execute_code: "local_broker", call_external_api: "local_broker",
  send_external_message: "local_broker", perform_sensitive_action: "local_broker",
};

/**
 * What an agent that joins a room can do without anybody granting more: exactly what taking part
 * in a room already meant before capabilities existed, so nothing that worked stops working.
 * Everything else — reading file contents, and every power over the machine or the outside
 * world — is denied until a person grants it.
 */
export const DEFAULT_AGENT_CAPABILITIES: ReadonlySet<AgentCapability> = new Set<AgentCapability>([
  "read_room_messages", "write_room_messages", "mention_participants", "invoke_agent",
  "update_tasks", "request_decision", "create_artifacts",
]);

export const isAgentCapability = (value: string): value is AgentCapability =>
  (AGENT_CAPABILITIES as readonly string[]).includes(value);
