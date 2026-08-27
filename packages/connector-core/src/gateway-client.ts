import { GatewayError, type GatewayConfig, type TaskSummary } from "./types.js";

export interface SessionHandle {
  sessionId?: string;
  sessionToken?: string;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Authenticated client for agent-gateway.v1. Owns credential and session handling and
 * nothing else: no sockets, no cursor, no local files.
 */
export class GatewayClient {
  private session: SessionHandle = {};

  constructor(
    private readonly config: GatewayConfig,
    /** Called whenever a session is opened or cleared, so the caller can persist it. */
    private readonly onSessionChange: (session: SessionHandle) => void = () => {},
  ) {}

  get sessionId() { return this.session.sessionId; }
  get sessionToken() { return this.session.sessionToken; }

  adoptSession(session: SessionHandle) {
    this.session = { sessionId: session.sessionId, sessionToken: session.sessionToken };
  }

  clearSession() {
    this.session = {};
    this.onSessionChange({});
  }

  private timeout() {
    const value = Number(this.config.httpTimeoutMs ?? DEFAULT_TIMEOUT_MS);
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
  }

  async http<T = any>(method: string, route: string, body?: unknown, token?: string, idempotencyKey?: string): Promise<T> {
    const headers: Record<string, string> = { authorization: "Bearer " + (token ?? this.config.credential) };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(`${this.config.baseUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeout()),
    });
    const text = await response.text();
    let value: any;
    try { value = text ? JSON.parse(text) : {}; } catch { value = { raw: text }; }
    if (!response.ok) {
      throw new GatewayError(
        `Gateway HTTP ${response.status}: ${value?.error?.code ?? "request_failed"} ${value?.error?.message ?? ""}`,
        response.status,
        value,
      );
    }
    return value as T;
  }

  async listRooms() {
    return this.http("GET", "/v1/agent-gateway/v1/rooms");
  }

  /**
   * A credential that names a different principal, or a room this credential cannot reach, is
   * a configuration error rather than a transient one — retrying it forever helps nobody.
   */
  async openSession(runtimeStatus: "idle" | "working" = "idle") {
    const rooms: any = await this.listRooms();
    if (rooms.agent_principal_id !== this.config.agentPrincipalId) {
      throw new GatewayError("Credential principal does not match local configuration", undefined, undefined, true);
    }
    if (!rooms.rooms?.some((room: any) => room.id === this.config.roomId)) {
      throw new GatewayError("Configured room is not authorized for this credential", undefined, undefined, true);
    }
    const opened: any = await this.http("POST", "/v1/agent-gateway/v1/sessions", { room_id: this.config.roomId, runtime_status: runtimeStatus });
    this.session = { sessionId: opened.session_id, sessionToken: opened.session_token };
    this.onSessionChange(this.session);
    return opened;
  }

  async ensureSession() {
    if (!this.session.sessionId || !this.session.sessionToken) await this.openSession();
    return this.session;
  }

  route(suffix: string) {
    return `/v1/agent-gateway/v1/sessions/${this.session.sessionId}${suffix}`;
  }

  async sessionHttp<T = any>(method: string, suffix: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    await this.ensureSession();
    return this.http<T>(method, this.route(suffix), body, this.session.sessionToken, idempotencyKey);
  }

  snapshot() { return this.sessionHttp("GET", "/snapshot"); }
  tasks() { return this.sessionHttp("GET", "/tasks"); }
  task(id: string) { return this.sessionHttp("GET", `/tasks/${id}`); }
  decision(id: string) { return this.sessionHttp("GET", `/decisions/${id}`); }
  describeSession() { return this.sessionHttp("GET", ""); }
  heartbeat(runtimeStatus: "idle" | "working") { return this.sessionHttp("POST", "/heartbeat", { runtime_status: runtimeStatus }); }
  disconnect() { return this.sessionHttp("POST", "/disconnect", {}); }

  sendMessage(input: { body: string; addressedPrincipalId?: string; taskId?: string }, idempotencyKey: string) {
    return this.sessionHttp("POST", "/messages", {
      body: input.body,
      ...(input.addressedPrincipalId ? { addressed_principal_id: input.addressedPrincipalId } : {}),
      ...(input.taskId ? { task_id: input.taskId } : {}),
    }, idempotencyKey);
  }

  updateTaskStatus(taskId: string, status: string, expectedVersion: number, idempotencyKey: string) {
    return this.sessionHttp("PATCH", `/tasks/${taskId}/status`, { status, expected_version: expectedVersion }, idempotencyKey);
  }

  completeTask(taskId: string, expectedVersion: number, idempotencyKey: string) {
    return this.sessionHttp("POST", `/tasks/${taskId}/complete`, { expected_version: expectedVersion }, idempotencyKey);
  }

  requestDecision(input: { title: string; question: string; rationale?: string; proposedAction: Record<string, unknown> }, idempotencyKey: string) {
    return this.sessionHttp("POST", "/decisions", {
      title: input.title,
      question: input.question,
      rationale: input.rationale ?? "",
      proposed_action: input.proposedAction,
    }, idempotencyKey);
  }

  /** Open work assigned to this principal, or null when room state could not be read. */
  async assignedWork(): Promise<TaskSummary[] | null> {
    try {
      const snapshot: any = await this.snapshot();
      return (snapshot.tasks ?? []).filter((task: TaskSummary) =>
        task.assignee_principal_id === this.config.agentPrincipalId && !["completed", "cancelled"].includes(task.status));
    } catch {
      return null;
    }
  }
}
