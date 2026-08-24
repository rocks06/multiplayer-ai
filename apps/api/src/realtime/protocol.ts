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
  | { type: "resync_required"; room_id: string; reason: "stale_cursor" | "cursor_ahead" | "gap" | "slow_client"; latest_seq: number }
  | { type: "access_revoked"; room_id: string }
  | { type: "protocol_error"; code: string; message: string };

export type ClientFrame = { type: "ack"; room_seq: number };
