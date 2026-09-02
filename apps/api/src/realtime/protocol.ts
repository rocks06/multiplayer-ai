export type SequenceObservation = "duplicate" | "next" | "gap";

export class SequenceTracker {
  constructor(public contiguousSeq: number) {}

  observe(roomSeq: number): SequenceObservation {
    if (roomSeq <= this.contiguousSeq) return "duplicate";
    if (roomSeq !== this.contiguousSeq + 1) return "gap";
    this.contiguousSeq = roomSeq;
    return "next";
  }
}

export interface RoomEventFrame {
  type: "event";
  room_id: string;
  event: Record<string, unknown> & { room_seq: number };
}

export type ServerFrame =
  | { type: "snapshot"; room_id: string; snapshot_seq: number; snapshot: unknown }
  | { type: "resumed"; room_id: string; after_seq: number; latest_seq: number }
  | RoomEventFrame
  | { type: "session.ready"; protocol:"agent-gateway.v1"; session_id:string; room_id:string; agent_principal_id:string; latest_seq:number; after_seq?:number }
  | { type: "room.snapshot"; room_id:string; snapshot_seq:number; snapshot:unknown }
  | { type: "room.event"; room_id:string; event:Record<string,unknown>&{room_seq:number} }
  | { type: "resync_required"; room_id: string; reason: "stale_cursor" | "cursor_ahead" | "gap" | "slow_client"; latest_seq: number }
  | { type: "access_revoked"; room_id: string }
  /* Replaced, not shut out. A connector that cannot tell these apart tells the person their
     access was removed and asks for a new enrollment code, when all that happened is that this
     agent came back on a newer connection — often the same Mac, moments earlier. */
  | { type: "session_superseded"; room_id: string; reason: string }
  | { type: "protocol_error"; code: string; message: string };

export type ClientFrame = { type: "ack"; room_seq: number };
