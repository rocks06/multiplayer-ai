export type PrincipalKind = "human" | "agent" | "system";
export type RoomRole = "manager" | "contributor" | "worker_agent";
export type TaskStatus = "open" | "in_progress" | "blocked" | "awaiting_decision" | "completed" | "cancelled";

export type Permission =
  | "room.read"
  | "message.send"
  | "task.create"
  | "task.update.own"
  | "task.update.any"
  | "member.manage";

export const ROLE_PERMISSIONS: Record<RoomRole, ReadonlySet<Permission>> = {
  manager: new Set<Permission>(["room.read", "message.send", "task.create", "task.update.own", "task.update.any", "member.manage"]),
  contributor: new Set<Permission>(["room.read", "message.send", "task.create", "task.update.own"]),
  worker_agent: new Set<Permission>(["room.read", "message.send", "task.update.own"]),
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
