// Provider-neutral contracts for an external agent connector. Nothing here knows about a
// particular agent runtime, a particular operating system, or a user interface.

export interface GatewayConfig {
  baseUrl: string;
  roomId: string;
  agentPrincipalId: string;
  credential: string;
  httpTimeoutMs?: number;
}

export interface RoomEvent {
  id?: string;
  room_seq: number;
  event_type: string;
  actor_principal_id?: string;
  actor_kind?: string;
  entity_type?: string;
  entity_id?: string;
  entity_version?: number | null;
  payload?: Record<string, unknown> | null;
}

export type ActionableMarker =
  | { key: string; type: "room.event"; event: RoomEvent }
  | { key: string; type: "room.snapshot"; snapshot_seq: number };

export interface TaskSummary {
  id: string;
  title?: string;
  status: string;
  version: number;
  assignee_principal_id: string | null;
}

/** Durable local state. Survives crashes; replay and exactly-once both depend on it. */
export interface ConnectorState {
  last_contiguous_seq: number | null;
  processed_event_ids: string[];
  pending_actionable_events: ActionableMarker[];
  session_id?: string;
  session_token?: string;
  room_id?: string;
  agent_principal_id?: string;
  connection?: string;
  hermes_running?: boolean;
  last_wake_at?: string;
  last_hermes_exit?: number;
  last_wake_error?: string;
  last_error?: string;
}

export interface StateStore {
  load(): ConnectorState;
  save(state: ConnectorState): void;
}

/** How an agent runtime is invited to call back into the room. */
export interface CommandSurface {
  /** Absolute command the runtime may run, with COMMAND substituted for a verb. */
  template: string;
  verbs: string[];
}

export interface AgentInvocation {
  profile: string;
  roomId: string;
  agentPrincipalId: string;
  /** Markers that caused this wake, already confirmed relevant to this principal. */
  trigger: ActionableMarker[];
  /** Live open work assigned to this principal, or null when room state was unreadable. */
  assignedTasks: TaskSummary[] | null;
  commandSurface: CommandSurface;
  /** Append-only file the runtime's own output should be written to. */
  logPath: string;
}

export interface RuntimeDetection {
  available: boolean;
  name: string;
  version?: string;
  path?: string;
  /** Why it is unavailable, phrased for a person to act on. */
  reason?: string;
}

export interface RuntimeHealth {
  ok: boolean;
  detail?: string;
}

export interface AgentInvocationResult {
  ok: boolean;
  exitCode: number;
  detail?: string;
}

/**
 * The only seam an agent runtime plugs into. Connector core must never import a concrete
 * adapter; adapters must never touch the credential, the cursor, or the durable markers.
 */
export interface AgentRuntimeAdapter {
  readonly id: string;
  detect(): Promise<RuntimeDetection>;
  health(): Promise<RuntimeHealth>;
  invoke(input: AgentInvocation): Promise<AgentInvocationResult>;
  /** Stop an in-flight invocation during shutdown. The marker stays pending for retry. */
  cancel?(): void;
}

export type ConnectionState =
  | "not_started"
  | "created"
  | "live"
  | "reconnecting"
  | "stalled"
  | "gap"
  | "resync_required"
  | "session_rejected"
  | "access_revoked"
  | "offline";

export class GatewayError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: any, readonly terminal = false) {
    super(message);
    this.name = "GatewayError";
  }
}
