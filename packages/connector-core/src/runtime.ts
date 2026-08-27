import fs from "node:fs";
import { EventStream, type EventDisposition, type StreamOptions } from "./event-stream.js";
import { GatewayClient } from "./gateway-client.js";
import { eventKey, isActionableCandidate, isRelevantActionable } from "./relevance.js";
import type {
  ActionableMarker,
  AgentRuntimeAdapter,
  CommandSurface,
  ConnectionState,
  ConnectorState,
  GatewayConfig,
  RoomEvent,
  StateStore,
} from "./types.js";

export interface ConnectorRuntimeOptions {
  config: GatewayConfig;
  profile: string;
  store: StateStore;
  adapter: AgentRuntimeAdapter;
  commandSurface: CommandSurface;
  logPath: string;
  wakeDelayMs?: number;
  stream?: Omit<StreamOptions, "baseUrl">;
}

const MAX_PROCESSED_IDS = 500;
const MAX_RETRY_MS = 30_000;

/**
 * Ties the Gateway stream to an agent runtime.
 *
 * The reliability contract, unchanged from the validated bridge: receive an event, durably
 * record an actionable marker, advance the contiguous cursor, acknowledge, confirm relevance,
 * invoke the runtime against live room state, and only then clear the marker. A crash between
 * acknowledgement and successful processing therefore loses no work, and a replay of already
 * processed work produces no second invocation.
 */
export class ConnectorRuntime {
  readonly client: GatewayClient;
  private readonly stream: EventStream;
  private state: ConnectorState;
  private stopping = false;
  private busy = false;
  private wakeTimer: NodeJS.Timeout | null = null;
  private retryDelay = 1000;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.state = options.store.load();
    this.client = new GatewayClient(options.config, session => {
      this.state.session_id = session.sessionId;
      this.state.session_token = session.sessionToken;
      if (session.sessionId) {
        this.state.room_id = options.config.roomId;
        this.state.agent_principal_id = options.config.agentPrincipalId;
        this.state.connection = "created";
      }
      this.save();
    });
    if (this.state.session_id && this.state.session_token) {
      this.client.adoptSession({ sessionId: this.state.session_id, sessionToken: this.state.session_token });
    }
    this.stream = new EventStream(this.client, {
      cursor: () => this.state.last_contiguous_seq,
      onConnectionState: state => { this.state.connection = state; this.save(); },
      onSnapshot: seq => this.applySnapshot(seq),
      onEvent: event => this.applyEvent(event),
      onResync: () => { this.state.last_contiguous_seq = null; this.state.connection = "resync_required"; this.save(); },
      onConnected: () => this.scheduleWake(0),
      onError: detail => { this.state.last_error = detail; this.save(); },
      runtimeStatus: () => (this.busy ? "working" : "idle"),
    }, { baseUrl: options.config.baseUrl, ...(options.stream ?? {}) });
  }

  get snapshotState(): ConnectorState { return this.state; }

  private save() { this.options.store.save(this.state); }

  private rememberActionable(marker: ActionableMarker) {
    if (!this.state.pending_actionable_events.some(item => item.key === marker.key)) {
      this.state.pending_actionable_events.push(marker);
    }
    this.save();
  }

  private applySnapshot(snapshotSeq: number) {
    this.state.last_contiguous_seq = snapshotSeq;
    this.state.processed_event_ids = [];
    this.rememberActionable({ key: `room.snapshot:${snapshotSeq}`, type: "room.snapshot", snapshot_seq: snapshotSeq });
    this.scheduleWake();
  }

  private applyEvent(event: RoomEvent): EventDisposition {
    const seq = Number(event.room_seq);
    const last = Number(this.state.last_contiguous_seq ?? 0);
    if (seq <= last) return "duplicate";
    if (seq !== last + 1) return "gap";
    this.state.last_contiguous_seq = seq;
    this.state.processed_event_ids = [...this.state.processed_event_ids, eventKey(event)].slice(-MAX_PROCESSED_IDS);
    if (isActionableCandidate(event, this.options.config.agentPrincipalId)) {
      this.rememberActionable({ key: eventKey(event), type: "room.event", event });
    } else {
      this.save();
    }
    this.scheduleWake();
    return "applied";
  }

  private scheduleWake(delay = this.options.wakeDelayMs ?? 750) {
    if (this.stopping || this.wakeTimer || this.busy || !this.state.pending_actionable_events.length) return;
    this.wakeTimer = setTimeout(() => { this.wakeTimer = null; void this.drain(); }, delay);
  }

  private async invoke(trigger: ActionableMarker[]) {
    this.state.hermes_running = true;
    this.state.last_wake_at = new Date().toISOString();
    this.save();
    await this.client.heartbeat("working").catch(() => {});
    const assignedTasks = await this.client.assignedWork();
    let exitCode = 1;
    try {
      const result = await this.options.adapter.invoke({
        profile: this.options.profile,
        roomId: this.options.config.roomId,
        agentPrincipalId: this.options.config.agentPrincipalId,
        trigger,
        assignedTasks,
        commandSurface: this.options.commandSurface,
        logPath: this.options.logPath,
      });
      exitCode = result.exitCode;
    } finally {
      this.state.hermes_running = false;
      this.state.last_hermes_exit = exitCode;
      this.save();
    }
    await this.client.heartbeat("idle").catch(() => {});
    return exitCode;
  }

  private async drain() {
    if (this.stopping || this.busy || !this.state.pending_actionable_events.length) return;
    this.busy = true;
    const candidates = [...this.state.pending_actionable_events];
    const relevant: ActionableMarker[] = [];
    const irrelevant: ActionableMarker[] = [];
    try {
      for (const marker of candidates) {
        const keep = await isRelevantActionable(marker, this.options.config.agentPrincipalId, {
          getDecision: id => this.client.decision(id),
          listTasks: async () => ((await this.client.snapshot()) as any).tasks ?? [],
        });
        (keep ? relevant : irrelevant).push(marker);
      }
      if (irrelevant.length) {
        const keys = new Set(irrelevant.map(item => item.key));
        this.state.pending_actionable_events = this.state.pending_actionable_events.filter(item => !keys.has(item.key));
        this.save();
      }
      if (!relevant.length) { this.retryDelay = 1000; return; }
      const code = await this.invoke(relevant);
      if (code !== 0) throw new Error(`Agent runtime exited with code ${code}`);
      const completed = new Set(relevant.map(item => item.key));
      this.state.pending_actionable_events = this.state.pending_actionable_events.filter(item => !completed.has(item.key));
      this.retryDelay = 1000;
      this.save();
    } catch (error) {
      const detail = String((error as any)?.message ?? error);
      try { fs.appendFileSync(this.options.logPath, `\nconnector wake failed; durable actionable events retained for retry: ${detail}\n`); } catch {}
      this.state.last_wake_error = detail;
      this.save();
      this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    } finally {
      this.busy = false;
      if (this.state.pending_actionable_events.length) this.scheduleWake(this.retryDelay);
    }
  }

  async start() {
    this.stopping = false;
    await this.stream.run();
  }

  stop(connection: ConnectionState = "offline") {
    this.stopping = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.options.adapter.cancel?.();
    this.stream.stop();
    this.state.connection = connection;
    this.save();
  }
}
