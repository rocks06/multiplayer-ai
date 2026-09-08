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


const message = (error: unknown) => String((error as any)?.message ?? error);

export const isTerminal = (error: unknown) =>
  (error as any)?.terminal === true ||
  message(error).includes("Gateway access revoked") ||
  ["gateway_unauthenticated", "room_access_denied", "room_not_found", "agent_not_found"].includes((error as any)?.body?.error?.code);

/** Terminal says stop; this says what to tell the person, and they are different questions. */
const terminalReason = (error: unknown): "unauthenticated" | "superseded" =>
  (error as any)?.reason === "superseded" ? "superseded" : "unauthenticated";

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
  private cancelDelay: (() => void) | null = null;

  constructor(
    private readonly client: GatewayClient,
    private readonly callbacks: StreamCallbacks,
    private readonly options: StreamOptions,
  ) {}

  stop() {
    this.stopping = true;
    this.cancelDelay?.();
    if (this.socket) { try { this.socket.terminate(); } catch {} }
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
        this.callbacks.onConnectionState("reconnecting");
        await this.client.ensureSession();
        if (this.stopping) break;
        const wsBase = this.options.baseUrl.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
        const cursor = this.callbacks.cursor();
        const url = `${wsBase}${this.client.route("/stream")}${cursor === null ? "" : `?after_seq=${cursor}`}`;
        const socket = new WebSocket(url, { headers: { authorization: `Bearer ${this.client.sessionToken}` } });
        this.socket = socket;


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
          let ready = false;
          heartbeat = setInterval(() => {
            if (!ready) return;
            void this.client.heartbeat(this.callbacks.runtimeStatus()).catch(reject);
          }, heartbeatInterval);
          socket.on("message", raw => {
            try {
              const frame = JSON.parse(raw.toString());
              if (frame.type === "session.ready" && !ready) {
                ready = true;
                this.callbacks.onConnectionState("live");
                connectDelay = baseDelay;
                this.callbacks.onConnected();
                return;
              }
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
                reject(new GatewayError("Gateway access revoked", undefined, undefined, true, "unauthenticated"));
                return;
              }
              /* This agent came back on a newer connection, so this one stands down. Ending the
                 loop is right — one runtime is one agent — but it is not an authentication
                 failure, and the person must not be asked for a new enrollment code because their
                 own Mac reconnected. */
              if (frame.type === "session_superseded") {
                this.callbacks.onConnectionState("superseded");
                reject(new GatewayError("Replaced by a newer connection for this agent",
                                        undefined, undefined, true, "superseded"));
                return;
              }
              if (frame.type === "protocol_error") reject(new GatewayError(`Gateway protocol error: ${frame.code}`));
            } catch (error) { reject(error); }
          });
          socket.once("close", code => resolve({ code }));
          socket.once("error", reject);
        });

        // Superseded can arrive as a bare close if the frame is lost in the teardown, and a
        // reconnect here would open a second session and retire the one that just replaced us.
        if (closure && closure.code === 4409) {
          this.callbacks.onConnectionState("superseded");
          throw new GatewayError("Replaced by a newer connection for this agent",
                                 undefined, undefined, true, "superseded");
        }
        // A rejected subscription can close before, or instead of, delivering protocol_error,
        // so the close code is authoritative for "this session is unusable".
        if (closure && (closure.code === 4401 || closure.code === 4403)) {
          this.callbacks.onConnectionState("session_rejected");
          this.client.clearSession();
          connectDelay = Math.min(connectDelay * 2, ceiling);
        }
      } catch (error) {
        this.callbacks.onError(message(error));
        if (isTerminal(error)) {
          this.callbacks.onConnectionState(terminalReason(error) === "superseded" ? "superseded" : "access_revoked");
          // Carry the reason out with the error, so the supervisor never has to read the message.
          if (!(error as any)?.reason) (error as any).reason = terminalReason(error);
          throw error;
        }
        this.callbacks.onConnectionState("reconnecting");
        // Retrying a session id the Gateway no longer accepts can never succeed.
        if (isSessionRejected(error)) this.client.clearSession();
        connectDelay = Math.min(connectDelay * 2, ceiling);
      } finally {
        if (heartbeat) clearInterval(heartbeat);
        if (watchdog) clearInterval(watchdog);
        this.socket?.terminate();
        this.socket = null;
      }
      if (!this.stopping) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); this.cancelDelay = null; resolve(); };
        const timer = setTimeout(finish, connectDelay + Math.floor(Math.random() * 250));
        this.cancelDelay = finish;
      });
    }
  }
}
