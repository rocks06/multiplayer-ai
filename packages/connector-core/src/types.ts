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

/**
 * How far along a runtime is, said plainly.
 *
 * "Available" was one boolean doing the work of six different situations, and the connector then
 * reported "a binary exists" as "healthy". A person whose Hermes was installed but unusable was
 * told it was ready, and a person whose Hermes was running perfectly was told nothing useful at
 * all. Each of these is a different sentence and a different next step.
 */
export type RuntimeReadiness =
  /** Nothing that answers is installed anywhere this adapter looks. */
  | "not_installed"
  /** Found, but older than this connector can drive. */
  | "unsupported_version"
  /** Installed and answering, but its background service is not running. */
  | "installed_not_running"
  /** Found and answering, but the way this connector drives it does not work. */
  | "control_unavailable"
  /** Installed, answering, and controllable. The only state that may be enrolled. */
  | "ready";

export interface RuntimeDetection {
  /** Kept as the shorthand for "found at all"; `readiness` is what decisions are made on. */
  available: boolean;
  readiness: RuntimeReadiness;
  name: string;
  version?: string;
  path?: string;
  /**
   * How this connector actually reaches the runtime — verified, never assumed.
   *
   * For a runtime driven through its command line this is that command, because that is genuinely
   * the transport. Inventing an http://127.0.0.1:port for something that speaks no HTTP is how a
   * runtime that was working fine came to look unreachable.
   */
  endpoint?: string;
  healthEndpoint?: string;
  transport?: "process" | "http" | "socket" | "cli";
  processId?: number;
  configPath?: string;
  /** Whether the runtime's own background service is up, where it has one. */
  serviceRunning?: boolean;
  /** Why it is not ready, phrased for a person to act on. */
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
  | "superseded"
  | "removed"
  | "offline";

export class GatewayError extends Error {
  /* Why this stopped, as a value rather than a sentence.
     The supervisor used to decide whether a credential was dead by matching the message against
     /401|403|unauthor|forbidden|revoked|invalid/. "Gateway access revoked" contains "revoked", so
     an agent that had merely been replaced by its own newer connection was reported to the person
     as access removed, with a request for a new enrollment code. Prose is not a status. */
  constructor(message: string, readonly status?: number, readonly body?: any,
              readonly terminal = false, readonly reason?: TerminalReason) {
    super(message);
    this.name = "GatewayError";
  }
}

/** The ways a connection ends for good, and they are not the same to a person.
 * `removed`: this agent was taken out of the room. Its credential still works, so nobody is asked
 * to sign in again; it connects again once it is back in a room. */
export type TerminalReason = "unauthenticated" | "superseded" | "removed";
