import type { DbPool } from "../db.js";
import { DEFAULT_NOTIFICATION_LEVEL } from "../room-service.js";
import { DomainError } from "../../../../packages/domain/src/index.js";

/** Why a person is being told: something visible, something said to them, or something only they can do. */
export type NotificationCategory = "informational" | "mention" | "action_required";
export type NotificationKind = "addressed" | "mention" | "room_message" | "decision_requested" | "agent_blocked" | "agent_failed" | "agent_finished";

export interface RoomNotification {
  id: string;
  kind: NotificationKind;
  category: NotificationCategory;
  company_id: string;
  room_id: string;
  room_name: string;
  room_seq: number;
  title: string;
  body: string;
  link: string;
  created_at: string;
}

/**
 * How far behind "now" the feed reads. A room event's time is its transaction's start, so one that
 * commits a moment after a later-started one can land behind a cursor that has already moved past
 * it. Reading only events older than this makes that impossible in practice for room commands.
 */
const SETTLE_SECONDS = 2;
const PAGE = 50;

/**
 * A person's notifications, derived from the room event log rather than written separately.
 *
 * Every room event exists exactly once — an idempotent retry or a reconnect replays it but never
 * appends it again — so a notification keyed by its event cannot be produced twice. Only rooms the
 * person is an active member of are read, only activity after they joined, never their own, and
 * nothing they have already read. Low-level activity (presence, sessions, bookkeeping) never qualifies.
 */
export class NotificationFeed {
  constructor(private readonly pool: DbPool, private readonly settleSeconds = SETTLE_SECONDS) {}

  async forUser(userId: string, after?: string) {
    const settled = await this.pool.query<{ at: string }>(`SELECT to_char((now() - make_interval(secs => $1::double precision)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') at`, [this.settleSeconds]);
    const horizon = settled.rows[0]!.at;
    // A first read starts from now: a new device is not handed its owner's entire history.
    if (!after) return { cursor: encode(horizon, "ffffffff-ffff-ffff-ffff-ffffffffffff"), notifications: [] as RoomNotification[] };
    const from = decode(after);

    const rows = await this.pool.query<any>(
      `WITH me AS (
         SELECT p.id principal_id, p.company_id FROM principals p
           JOIN company_users cu ON cu.company_id=p.company_id AND cu.user_id=p.user_id AND cu.status='active'
          WHERE p.user_id=$1 AND p.kind='human' AND p.status='active')
       SELECT e.id event_id, e.company_id, e.room_id, r.name room_name, e.room_seq::int room_seq, e.event_type, e.entity_id,
              e.actor_display_name, e.actor_kind, e.payload, e.created_at, to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') created_at_text,
              me.principal_id, rm.role, t.title task_title, t.created_by_principal_id task_creator,
              COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}') level
         FROM me
         JOIN room_members rm ON rm.company_id=me.company_id AND rm.principal_id=me.principal_id AND rm.status='active'
         JOIN rooms r ON r.company_id=rm.company_id AND r.id=rm.room_id AND r.status='active'
         JOIN room_events e ON e.company_id=rm.company_id AND e.room_id=rm.room_id
         LEFT JOIN tasks t ON t.company_id=e.company_id AND t.id=e.entity_id AND e.entity_type='task'
         LEFT JOIN room_read_cursors rc ON rc.company_id=rm.company_id AND rc.room_id=rm.room_id AND rc.principal_id=rm.principal_id
         LEFT JOIN room_notification_preferences np ON np.company_id=rm.company_id AND np.room_id=rm.room_id AND np.user_id=$1
        WHERE (e.created_at, e.id) > ($2::timestamptz, $3::uuid) AND e.created_at <= $4::timestamptz
          AND e.created_at > rm.joined_at AND e.actor_principal_id <> me.principal_id
          AND e.room_seq > COALESCE(rc.last_read_seq, 0)
          /* What this person asked to be told about this room. Being sent to, named, or needed
             are what "direct and mentions" means; "all" is the room's activity as well, minus the
             turns agents take among themselves in a collaboration, which are progress rather than
             anything asked of a person. Unread state ignores all of this and counts everything. */
          AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}')<>'off'
          AND ((e.event_type='message.sent' AND (
                  (e.payload->>'addressed_principal_id'=me.principal_id::text AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}') IN ('all','direct_mentions'))
               OR (e.payload->'mentioned_principal_ids' @> to_jsonb(me.principal_id::text) AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}') IN ('all','direct_mentions','mentions'))
               OR (COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}')='all'
                   AND NOT (e.actor_kind='agent' AND COALESCE(e.payload->'collaboration','null'::jsonb)<>'null'::jsonb))))
            /* Needs you is a fixed set, not a judgement: a decision only a person can make, an
               agent blocked waiting for one, and a run that has failed for good — which is also
               how a missing permission, credential or input arrives. */
            OR (e.event_type='decision.requested' AND rm.role='manager' AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}') IN ('all','direct_mentions','needs_you'))
            OR (e.event_type='task.blocked' AND e.actor_kind='agent' AND (rm.role='manager' OR t.created_by_principal_id=me.principal_id)
                AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}') IN ('all','direct_mentions','needs_you'))
            OR (e.event_type='agent.run_failed' AND (rm.role='manager' OR EXISTS(
                  SELECT 1 FROM agent_human_relationships rel WHERE rel.company_id=e.company_id
                    AND rel.agent_principal_id=e.actor_principal_id AND rel.human_principal_id=me.principal_id))
                AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}') IN ('all','direct_mentions','needs_you'))
            OR (e.event_type='task.completed' AND e.actor_kind='agent' AND (rm.role='manager' OR t.created_by_principal_id=me.principal_id)
                AND COALESCE(np.level,'${DEFAULT_NOTIFICATION_LEVEL}')='all'))
        ORDER BY e.created_at, e.id
        LIMIT ${PAGE}`,
      [userId, from.at, from.id, horizon]);

    const notifications = rows.rows.map(describe);
    const last = rows.rows.at(-1);
    // A full page means more may follow at once; otherwise everything up to the horizon has been seen.
    const cursor = last && rows.rows.length === PAGE
      ? encode(last.created_at_text, last.event_id)
      : encode(maxTime(horizon, from.at), "ffffffff-ffff-ffff-ffff-ffffffffffff");
    return { cursor, notifications };
  }
}

function describe(row: any): RoomNotification {
  const room = { company_id: row.company_id, room_id: row.room_id, room_name: row.room_name, room_seq: row.room_seq };
  const actor = row.actor_display_name as string;
  const created_at = new Date(row.created_at).toISOString();
  const link = (focus: string) =>
    `multiplayerai://room?company=${row.company_id}&room=${row.room_id}&focus=${encodeURIComponent(focus)}`;
  if (row.event_type === "message.sent") {
    const direct = row.payload?.addressed_principal_id === row.principal_id;
    const named = Array.isArray(row.payload?.mentioned_principal_ids) && row.payload.mentioned_principal_ids.includes(row.principal_id);
    const text = excerpt(row.payload?.body_text) || "Shared a file";
    // Everything in a room this person asked to hear all of: theirs to read, not asked of them.
    if (!direct && !named) {
      return { id: row.event_id, ...room, created_at, link: link(`message:${row.entity_id}`), body: text,
        kind: "room_message", category: "informational", title: `${actor} posted in ${row.room_name}` };
    }
    /* "Sent you a message" claimed something the product does not do: a room is shared, and a
       message addressed to one person is read by everyone in it, agents included. Being addressed
       is real and worth a notification — it is being spoken to, not being spoken to privately. */
    return { id: row.event_id, ...room, created_at, link: link(`message:${row.entity_id}`), body: text,
      kind: direct ? "addressed" : "mention", category: "mention",
      title: direct ? `${actor} addressed you` : `${actor} mentioned you` };
  }
  if (row.event_type === "decision.requested") {
    return { id: row.event_id, ...room, created_at, link: link(`decision:${row.entity_id}`),
      kind: "decision_requested", category: "action_required",
      title: `${actor} needs your decision`, body: excerpt(row.payload?.title) || "A decision is waiting for you" };
  }
  if (row.event_type === "agent.run_failed") {
    const code = typeof row.payload?.error_code === "string" ? row.payload.error_code : "";
    // The run itself is not a thing to open: the link lands in the room, which is where it shows.
    return { id: row.event_id, ...room, created_at, link: link(`run:${row.entity_id}`),
      kind: "agent_failed", category: "action_required",
      title: `${actor} stopped and needs you`,
      body: code ? `Its run failed: ${code.replace(/_/g, " ")}` : "Its run failed and cannot continue without a person" };
  }
  if (row.event_type === "task.blocked") {
    return { id: row.event_id, ...room, created_at, link: link(`task:${row.entity_id}`),
      kind: "agent_blocked", category: "action_required",
      title: `${actor} is blocked`, body: excerpt(row.task_title) || "Work is waiting on a person" };
  }
  return { id: row.event_id, ...room, created_at, link: link(`task:${row.entity_id}`),
    kind: "agent_finished", category: "informational",
    title: `${actor} finished work`, body: excerpt(row.task_title) || "A task was completed" };
}

const excerpt = (text: unknown) => typeof text === "string" ? text.replace(/\s+/g, " ").trim().slice(0, 180) : "";
const maxTime = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

function encode(at: string, id: string) {
  return Buffer.from(JSON.stringify({ at, id })).toString("base64url");
}

function decode(cursor: string): { at: string; id: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof value?.at === "string" && !Number.isNaN(Date.parse(value.at))
        && typeof value?.id === "string" && /^[0-9a-f-]{36}$/i.test(value.id)) return value;
  } catch {}
  throw new DomainError("invalid_cursor", "That notification position is not valid. Start again without one.", 400);
}
