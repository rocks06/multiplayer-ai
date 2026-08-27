import WebSocket from "ws";
import type { GatewayClient } from "./gateway-client.js";
import { GatewayError, type ConnectionState, type RoomEvent } from "./types.js";

export type EventDisposition = "applied" | "duplicate" | "gap";

export interface StreamCallbacks {
  /** Highest contiguous room sequence this connector has durably applied. */
  cursor(): number | null;
  onConnectionState(state: ConnectionState): void;
  onSnapshot(snapshotSeq: number): void;
  onEvent(event: RoomEvent): EventDisposition;
  /** Server asked for a full resynchronisation; the cursor must be discarded. */
  onResync(): void;
  onConnected(): void;
  onError(detail: string): void;
  runtimeStatus(): "idle" | "working";
}

export interface StreamOptions {
  baseUrl: string;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  pingIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const message = (error: unknown) => String((error as any)?.message ?? error);

const isTerminal = (error: unknown) =>
  (error as any)?.terminal === true ||
  message(error).includes("Gateway access revoked") ||
  ((error as any)?.status === 401 && (error as any)?.body?.error?.code === "gateway_unauthenticated");

const isSessionRejected = (error: unknown) =>
  (error as any)?.body?.error?.code === "gateway_session_invalid" ||
  message(error).includes("gateway_session_invalid");

/**
 * The durable connection to a room's event stream.
 *
 * Reconnection and replay are this connector's own responsibility, never a supervisor's:
 * ordinary Wi-Fi loss, sleep, a dropped socket, or a Gateway restart must recover with no
 * human action. PostgreSQL remains authoritative; this socket is only transport.
 */
export class EventStream {
  private stopping = false;
  private socket: WebSocket | null = null;

  constructor(
    private readonly client: GatewayClient,
    private readonly callbacks: StreamCallbacks,
    private readonly options: StreamOptions,
  ) {}

  stop() {
    this.stopping = true;
    if (this.socket) { try { this.socket.close(); } catch {} }
  }

  async run() {
    const baseDelay = Number(this.options.reconnectBaseMs ?? 1000);
    const ceiling = Number(this.options.reconnectMaxMs ?? 30_000);
    const pingInterval = Number(this.options.pingIntervalMs ?? 20_000);
    const heartbeatInterval = Number(this.options.heartbeatIntervalMs ?? 20_000);
    let connectDelay = baseDelay;

    while (!this.stopping) {
      let heartbeat: NodeJS.Timeout | null = null;
      let watchdog: NodeJS.Timeout | null = null;
      try {
        await this.client.ensureSession();
        const wsBase = this.options.baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
        const cursor = this.callbacks.cursor();
        const url = `${wsBase}${this.client.route("/stream")}${cursor === null ? "" : `?after_seq=${cursor}`}`;
        const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.client.sessionToken}` } });
        this.socket = socket;

        await new Promise<void>((resolve, reject) => {
          socket.once("open", () => resolve());
          socket.once("error", reject);
        });
        this.callbacks.onConnectionState("live");
        connectDelay = baseDelay;
        this.callbacks.onConnected();

        heartbeat = setInterval(() => {
          void this.client.heartbeat(this.callbacks.runtimeStatus()).catch(() => {});
        }, heartbeatInterval);

        // A slept laptop or a silently dropped route leaves a half-open socket that never
        // emits close. Unanswered pings are the only reliable signal it is gone.
        let pongAt = Date.now();
        socket.on("pong", () => { pongAt = Date.now(); });
        watchdog = setInterval(() => {
          if (Date.now() - pongAt > pingInterval * 2.5) {
            this.callbacks.onConnectionState("stalled");
            socket.terminate();
            return;
          }
          try { socket.ping(); } catch {}
        }, pingInterval);

        const closure = await new Promise<{ code: number } | undefined>((resolve, reject) => {
          socket.on("message", raw => {
            try {
              const frame = JSON.parse(raw.toString());
              if (frame.type === "room.snapshot") {
                this.callbacks.onSnapshot(Number(frame.snapshot_seq));
                return;
              }
              if (frame.type === "room.event") {
                const disposition = this.callbacks.onEvent(frame.event as RoomEvent);
                if (disposition === "duplicate") return;
                if (disposition === "gap") { this.callbacks.onConnectionState("gap"); socket.close(); return; }
                socket.send(JSON.stringify({ type: "ack", room_seq: Number(frame.event.room_seq) }));
                return;
              }
              if (frame.type === "resync_required") { this.callbacks.onResync(); socket.close(); return; }
              if (frame.type === "access_revoked") {
                this.callbacks.onConnectionState("access_revoked");
                reject(new GatewayError("Gateway access revoked", undefined, undefined, true));
                return;
              }
              if (frame.type === "protocol_error") reject(new GatewayError(`Gateway protocol error: ${frame.code}`));
            } catch (error) { reject(error); }
          });
          socket.once("close", code => resolve({ code }));
          socket.once("error", reject);
        });

        // A rejected subscription can close before, or instead of, delivering protocol_error,
        // so the close code is authoritative for "this session is unusable".
        if (closure && (closure.code === 4401 || closure.code === 4403)) {
          this.callbacks.onConnectionState("session_rejected");
          this.client.clearSession();
          connectDelay = Math.min(connectDelay * 2, ceiling);
        }
      } catch (error) {
        this.callbacks.onConnectionState("reconnecting");
        this.callbacks.onError(message(error));
        if (isTerminal(error)) throw error;
        // Retrying a session id the Gateway no longer accepts can never succeed.
        if (isSessionRejected(error)) this.client.clearSession();
        connectDelay = Math.min(connectDelay * 2, ceiling);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (watchdog) clearInterval(watchdog);
      }
      if (!this.stopping) await sleep(connectDelay + Math.floor(Math.random() * 250));
    }
  }
}
