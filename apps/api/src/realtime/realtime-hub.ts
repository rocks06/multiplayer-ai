import type { PoolClient } from "pg";
import WebSocket from "ws";
import { DomainError } from "../../../../packages/domain/src/index.js";
import type { DbPool } from "../db.js";
import { RoomService } from "../room-service.js";
import { SequenceTracker, type ClientFrame, type ServerFrame } from "./protocol.js";

export interface RealtimeOptions {
  pollIntervalMs?: number;
  maxReplayEvents?: number;
  maxUnackedEvents?: number;
  maxBufferedBytes?: number;
  batchSize?: number;
  listenNotifications?: boolean;
}

interface Session {
  socket: WebSocket;
  companyId: string;
  roomId: string;
  principalId: string;
  lastSentSeq: number;
  lastAckedSeq: number;
  pumping: boolean;
  rerun: boolean;
  protocol: "room.v1" | "agent-gateway.v1";
  gatewaySessionId?: string;
  validate?: () => Promise<void>;
  onAck?: (roomSeq:number) => Promise<void>;
  onDisconnect?: () => Promise<void>;
}

const defaults: Required<RealtimeOptions> = {
  pollIntervalMs: 1_000,
  maxReplayEvents: 10_000,
  maxUnackedEvents: 500,
  maxBufferedBytes: 1_048_576,
  batchSize: 500,
  listenNotifications: true,
};

export class RealtimeHub {
  private readonly options: Required<RealtimeOptions>;
  private readonly sessions = new Set<Session>();
  private listener?: PoolClient;
  private pollTimer?: NodeJS.Timeout;
  private retryTimer?: NodeJS.Timeout;
  private stopping = false;

  constructor(
    private readonly pool: DbPool,
    private readonly service: RoomService,
    options: RealtimeOptions = {},
  ) {
    this.options = {...defaults, ...options};
  }

  async start() {
    this.stopping = false;
    this.pollTimer = setInterval(() => this.pollAll(), this.options.pollIntervalMs);
    this.pollTimer.unref();
    if (this.options.listenNotifications) await this.startListener();
  }

  async stop() {
    this.stopping = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const session of [...this.sessions]) {
      session.socket.close(1001, "gateway_shutdown");
      this.sessions.delete(session);
    }
    if (this.listener) {
      const listener = this.listener;
      this.listener = undefined;
      listener.removeAllListeners("notification");
      listener.removeAllListeners("error");
      try { await listener.query("UNLISTEN room_events"); } catch {}
      try { await listener.query("UNLISTEN agent_sessions"); } catch {}
      listener.release();
    }
  }

  async attach(socket: WebSocket, input: {companyId:string; roomId:string; principalId:string; afterSeq?:number; protocol?:"room.v1"|"agent-gateway.v1"; gatewaySessionId?:string; validate?:()=>Promise<void>; onAck?:(roomSeq:number)=>Promise<void>; onDisconnect?:()=>Promise<void>}) {
    const session: Session = {
      socket,
      companyId: input.companyId,
      roomId: input.roomId,
      principalId: input.principalId,
      lastSentSeq: input.afterSeq ?? 0,
      lastAckedSeq: input.afterSeq ?? 0,
      pumping: false,
      rerun: false,
      protocol: input.protocol ?? "room.v1",
      gatewaySessionId: input.gatewaySessionId,
      validate: input.validate,
      onAck: input.onAck,
      onDisconnect: input.onDisconnect,
    };
    let cleaned = false;
    const cleanup = () => { if(cleaned)return; cleaned=true; this.sessions.delete(session); if(session.onDisconnect)void session.onDisconnect().catch(()=>{}); };
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", data => this.onClientFrame(session, data.toString()));

    try {
      if(session.validate) await session.validate();
      const latestSeq = await this.service.roomCursor(input.companyId, input.roomId, input.principalId);
      if (input.afterSeq === undefined) {
        const snapshot = await this.service.snapshot(input.companyId, input.roomId, input.principalId);
        session.lastSentSeq = snapshot.snapshot_seq;
        session.lastAckedSeq = snapshot.snapshot_seq;
        this.sessions.add(session);
        if(session.protocol==="agent-gateway.v1") {
          this.send(session,{type:"session.ready",protocol:"agent-gateway.v1",session_id:session.gatewaySessionId!,room_id:input.roomId,agent_principal_id:input.principalId,latest_seq:snapshot.snapshot_seq});
          this.send(session,{type:"room.snapshot",room_id:input.roomId,snapshot_seq:snapshot.snapshot_seq,snapshot});
        } else this.send(session, {type:"snapshot",room_id:input.roomId,snapshot_seq:snapshot.snapshot_seq,snapshot});
      } else {
        if (input.afterSeq > latestSeq) return this.requireResync(session, "cursor_ahead", latestSeq);
        if (latestSeq - input.afterSeq > this.options.maxReplayEvents) return this.requireResync(session, "stale_cursor", latestSeq);
        this.sessions.add(session);
        if(session.protocol==="agent-gateway.v1") this.send(session,{type:"session.ready",protocol:"agent-gateway.v1",session_id:session.gatewaySessionId!,room_id:input.roomId,agent_principal_id:input.principalId,after_seq:input.afterSeq,latest_seq:latestSeq});
        else this.send(session, {type:"resumed",room_id:input.roomId,after_seq:input.afterSeq,latest_seq:latestSeq});
      }
      await this.pump(session);
    } catch (error) {
      cleanup();
      if (error instanceof DomainError) {
        this.send(session,{type:"protocol_error",code:error.code,message:error.message});
        socket.close(4403,"forbidden");
        return;
      }
      socket.close(1011,"realtime_error");
    }
  }

  /**
   * A session this one replaced. Close its socket now rather than letting it find out.
   *
   * A superseded session still holds an open stream, and until something fails it keeps
   * acknowledging events as though it were the live one. It would be refused eventually,
   * but "eventually" is a window in which two sockets both look like the agent. Closing on
   * the notification makes the handover immediate, and the close code says why, so a
   * connector can tell being replaced from being shut out.
   */
  retire(gatewaySessionId:string, reason:string) {
    for (const session of [...this.sessions]) {
      if (session.gatewaySessionId !== gatewaySessionId) continue;
      /* Say which of the two this is. Both used to send access_revoked, so a Mac that had just
         rebound itself was told its access had been removed and asked for a new code — while the
         room went on showing it connected. Supersession is ordinary and recoverable; revocation
         is not, and only one of them should ever reach a person. */
      this.send(session,{type:"session_superseded",room_id:session.roomId,reason});
      session.socket.close(4409,reason);
      this.sessions.delete(session);
    }
  }
  wake(companyId:string, roomId:string) {
    for (const session of this.sessions) {
      if (session.companyId === companyId && session.roomId === roomId) void this.pump(session);
    }
  }

  private async startListener() {
    if (this.stopping || this.listener) return;
    try {
      const listener = await this.pool.connect();
      this.listener = listener;
      listener.on("notification", notification => {
        if (!notification.payload) return;
        try {
          if (notification.channel === "room_events") {
            const wake = JSON.parse(notification.payload) as {company_id:string;room_id:string};
            this.wake(wake.company_id,wake.room_id);
            return;
          }
          if (notification.channel === "agent_sessions") {
            const retired = JSON.parse(notification.payload) as {session_id:string;reason:string};
            this.retire(retired.session_id, retired.reason);
          }
        } catch {}
      });
      listener.on("error", () => {
        if (this.listener === listener) this.listener = undefined;
        try { listener.release(true); } catch {}
        this.scheduleListenerRetry();
      });
      await listener.query("LISTEN room_events");
      await listener.query("LISTEN agent_sessions");
    } catch {
      if (this.listener) {
        try { this.listener.release(true); } catch {}
        this.listener = undefined;
      }
      this.scheduleListenerRetry();
    }
  }

  private scheduleListenerRetry() {
    if (this.stopping || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.startListener();
    }, Math.max(100,this.options.pollIntervalMs));
    this.retryTimer.unref();
  }

  private pollAll() {
    for (const session of this.sessions) void this.pump(session);
  }

  private async pump(session: Session): Promise<void> {
    if (!this.sessions.has(session) || session.socket.readyState !== WebSocket.OPEN) return;
    if (session.pumping) { session.rerun = true; return; }
    session.pumping = true;
    try {
      if(session.validate) await session.validate();
      const latestSeq = await this.service.roomCursor(session.companyId,session.roomId,session.principalId);
      if (session.lastSentSeq > latestSeq) return this.requireResync(session,"cursor_ahead",latestSeq);
      if (this.isSlow(session)) return this.requireResync(session,"slow_client",latestSeq);
      const result = await this.service.events(session.companyId,session.roomId,session.principalId,session.lastSentSeq,this.options.batchSize);
      const tracker = new SequenceTracker(session.lastSentSeq);
      for (const event of result.events) {
        const observation = tracker.observe(event.room_seq);
        if (observation === "duplicate") continue;
        if (observation === "gap") return this.requireResync(session,"gap",latestSeq);
        if (this.isSlow(session)) return this.requireResync(session,"slow_client",latestSeq);
        this.send(session,session.protocol==="agent-gateway.v1"?{type:"room.event",room_id:session.roomId,event}:{type:"event",room_id:session.roomId,event});
        session.lastSentSeq = event.room_seq;
      }
      if (result.events.length === this.options.batchSize && session.lastSentSeq < latestSeq) session.rerun = true;
    } catch (error) {
      if (error instanceof DomainError && (error.code === "room_access_denied" || error.code === "forbidden" || error.code === "gateway_session_invalid")) {
        this.send(session,{type:"access_revoked",room_id:session.roomId});
        session.socket.close(4403,"access_revoked");
        this.sessions.delete(session);
      }
    } finally {
      session.pumping = false;
      if (session.rerun) { session.rerun = false; void this.pump(session); }
    }
  }

  private onClientFrame(session:Session, raw:string) {
    let frame:ClientFrame;
    try { frame=JSON.parse(raw) as ClientFrame; } catch { return this.protocolError(session,"invalid_json","Frame must be valid JSON"); }
    if (frame.type !== "ack" || !Number.isSafeInteger(frame.room_seq) || frame.room_seq < 0) return this.protocolError(session,"invalid_frame","Expected {type:'ack',room_seq:number}");
    if (frame.room_seq > session.lastSentSeq) return this.protocolError(session,"ack_ahead","Cannot acknowledge an event not sent by this gateway");
    if (frame.room_seq > session.lastAckedSeq) { session.lastAckedSeq = frame.room_seq; if(session.onAck)void session.onAck(frame.room_seq).catch(()=>{}); }
  }

  private isSlow(session:Session) {
    return session.socket.bufferedAmount > this.options.maxBufferedBytes || session.lastSentSeq - session.lastAckedSeq > this.options.maxUnackedEvents;
  }

  private requireResync(session:Session, reason:"stale_cursor"|"cursor_ahead"|"gap"|"slow_client", latestSeq:number) {
    this.send(session,{type:"resync_required",room_id:session.roomId,reason,latest_seq:latestSeq});
    session.socket.close(4409,"resync_required");
    this.sessions.delete(session);
  }

  private protocolError(session:Session,code:string,message:string) {
    this.send(session,{type:"protocol_error",code,message});
    session.socket.close(4400,"protocol_error");
    this.sessions.delete(session);
  }

  private send(session:Session,frame:ServerFrame) {
    if (session.socket.readyState === WebSocket.OPEN) session.socket.send(JSON.stringify(frame));
  }
}
