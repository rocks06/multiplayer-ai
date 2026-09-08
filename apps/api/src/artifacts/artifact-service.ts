import { v7 as uuidv7 } from "uuid";
import type { DbPool } from "../db.js";
import { DomainError } from "../../../../packages/domain/src/index.js";
import type { ArtifactStorage } from "./storage.js";

/** How long a download link lives. Long enough to click, short enough not to be worth passing on. */
const SIGNED_URL_SECONDS = 60;
const MAX_BYTES = 50 * 1024 * 1024;

export interface ArtifactRow {
  id: string; filename: string; content_type: string; byte_size: number;
  creator_principal_id: string; creator_display_name: string;
  status: string; metadata: Record<string, unknown>; created_at: string;
}

/**
 * Files in a room, whoever made them.
 *
 * A file an agent generated and a file a person attached are the same thing to everyone who later
 * needs it, so there is one path here and one set of permissions. Membership of the room is the
 * only thing that grants access, and it is checked on the way in and again on the way out — a
 * download link is authorization that has already left, so it is never issued without asking first.
 */
export class ArtifactService {
  constructor(private readonly pool: DbPool, private readonly storage: ArtifactStorage) {}

  /** Nobody outside a room may read or write its files, whatever they know about them. */
  private async requireMember(companyId: string, roomId: string, principalId: string) {
    const member = await this.pool.query(
      `SELECT 1 FROM room_members WHERE company_id=$1 AND room_id=$2 AND principal_id=$3 AND status='active'`,
      [companyId, roomId, principalId]);
    if (!member.rowCount) {
      throw new DomainError("room_access_denied", "You are not a member of this room", 403);
    }
  }

  /**
   * The path bytes are stored under.
   *
   * Built from ids this service generated and nothing else. A filename arriving from an upload or
   * an agent is untrusted text; a path built from one is a traversal, and a path built from a
   * display name is a collision the first time two people attach `report.pdf`.
   */
  private storageKey(companyId: string, roomId: string, artifactId: string) {
    return `companies/${companyId}/rooms/${roomId}/${artifactId}`;
  }

  /**
   * Record a file, store it, then say it arrived — in that order.
   *
   * The row exists before the bytes do, so a failed upload leaves something to find rather than a
   * silence; and it is only marked ready once the upload has actually returned. Nothing tells a
   * room it has a file until the file is genuinely there.
   */
  async create(input: {
    companyId: string; roomId: string; principalId: string;
    filename: string; contentType: string; body: Uint8Array;
    metadata?: Record<string, unknown>;
  }) {
    await this.requireMember(input.companyId, input.roomId, input.principalId);
    if (input.body.byteLength === 0) {
      throw new DomainError("artifact_empty", "That file is empty", 400);
    }
    if (input.body.byteLength > MAX_BYTES) {
      throw new DomainError("artifact_too_large",
        `That file is larger than the ${Math.round(MAX_BYTES / 1024 / 1024)} MB limit`, 413);
    }
    const id = uuidv7();
    const key = this.storageKey(input.companyId, input.roomId, id);
    const filename = safeFilename(input.filename);
    const contentType = safeContentType(input.contentType);

    await this.pool.query(
      `INSERT INTO artifacts(id,company_id,room_id,creator_principal_id,filename,content_type,byte_size,storage_key,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, input.companyId, input.roomId, input.principalId, filename, contentType,
       input.body.byteLength, key, JSON.stringify(input.metadata ?? {})]);

    try {
      await this.storage.put(key, input.body, contentType);
    } catch {
      await this.pool.query(`UPDATE artifacts SET status='failed' WHERE id=$1`, [id]);
      throw new DomainError("artifact_upload_failed",
        "The file could not be stored, so it has not been delivered", 502);
    }
    await this.pool.query(
      `UPDATE artifacts SET status='ready',delivered_at=now() WHERE id=$1`, [id]);
    return { id, filename, content_type: contentType, byte_size: input.body.byteLength };
  }

  /** Attach delivered files to a message. Anything not ready is refused rather than shown. */
  async attach(input: {
    companyId: string; roomId: string; messageId: string; artifactIds: string[];
  }, client: { query: DbPool["query"] } = this.pool) {
    for (const [position, artifactId] of input.artifactIds.entries()) {
      const ready = await client.query(
        `SELECT 1 FROM artifacts WHERE company_id=$1 AND room_id=$2 AND id=$3 AND status='ready'`,
        [input.companyId, input.roomId, artifactId]);
      if (!ready.rowCount) {
        throw new DomainError("artifact_not_ready", "That file is not available in this room", 409);
      }
      await client.query(
        `INSERT INTO message_artifacts(company_id,room_id,message_id,artifact_id,position)
         VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
        [input.companyId, input.roomId, input.messageId, artifactId, position]);
    }
  }

  /** Everything this room has produced, newest first. The room's durable work product. */
  async list(companyId: string, roomId: string, principalId: string): Promise<ArtifactRow[]> {
    await this.requireMember(companyId, roomId, principalId);
    const found = await this.pool.query<ArtifactRow>(
      `SELECT a.id,a.filename,a.content_type,a.byte_size::int,a.creator_principal_id,
              p.display_name creator_display_name,a.status,a.metadata,a.created_at
         FROM artifacts a JOIN principals p ON p.company_id=a.company_id AND p.id=a.creator_principal_id
        WHERE a.company_id=$1 AND a.room_id=$2 AND a.status='ready'
        ORDER BY a.created_at DESC`, [companyId, roomId]);
    return found.rows;
  }

  /** Read bytes through the authenticated room boundary, not a browser navigation to storage. */
  async content(companyId: string, roomId: string, principalId: string, artifactId: string) {
    await this.requireMember(companyId, roomId, principalId);
    const found = await this.pool.query<{storage_key:string;filename:string;content_type:string}>(
      `SELECT storage_key,filename,content_type FROM artifacts WHERE company_id=$1 AND room_id=$2 AND id=$3 AND status='ready'`,
      [companyId, roomId, artifactId]);
    const row = found.rows[0];
    if (!row) throw new DomainError('artifact_not_found', 'This file is not available in this room', 404);
    if (!this.storage.read) throw new DomainError('artifact_unavailable', 'File downloads are unavailable from this storage provider', 503);
    try { return {...row, bytes: await this.storage.read(row.storage_key)}; }
    catch { throw new DomainError('artifact_missing', 'The stored file could not be read. Retry or ask the sender to upload it again.', 502); }
  }

  /**
   * A link to download one file with, checked first and expiring quickly.
   *
   * The check happens here rather than being left to the link, because a signed URL is
   * authorization that has already left the building: once it exists nothing can ask again.
   */
  async downloadUrl(companyId: string, roomId: string, principalId: string, artifactId: string) {
    await this.requireMember(companyId, roomId, principalId);
    const found = await this.pool.query<{ storage_key: string; filename: string; content_type: string }>(
      `SELECT storage_key,filename,content_type FROM artifacts
        WHERE company_id=$1 AND room_id=$2 AND id=$3 AND status='ready'`,
      [companyId, roomId, artifactId]);
    if (!found.rowCount) throw new DomainError("artifact_not_found", "No such file in this room", 404);
    const row = found.rows[0]!;
    return {
      url: await this.storage.signedUrl(row.storage_key, SIGNED_URL_SECONDS),
      filename: row.filename,
      content_type: row.content_type,
      expires_in: SIGNED_URL_SECONDS,
    };
  }
}

/**
 * A name to show, with everything that could make it a path taken out.
 *
 * Slashes and dot-runs are what turn a filename into a traversal, and control characters are what
 * make one thing look like another in a list. This is display text and nothing else — the storage
 * key is built from ids — but a name is still shown to people and put in a download header.
 */
export function safeFilename(raw: string) {
  const stripped = Array.from(raw)
    .filter(character => character >= " " && character !== "\u007f")
    .join("")
    .replace(/[\\/]/g, "")
    .replace(/^\.+/, "")
    .trim();
  return (stripped || "file").slice(0, 255);
}

/**
 * What we will admit a file is.
 *
 * A content type is a claim made by whoever uploaded it, and it decides whether a browser renders
 * something or downloads it. Anything unrecognised becomes a byte stream, which is the safe
 * answer. SVG and HTML are deliberately absent from both lists: each can carry script, and served
 * inline from our own origin that is stored cross-site scripting with extra steps.
 */
const PREVIEWABLE = new Set([
  "application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif",
  "text/plain", "text/markdown", "text/csv",
]);
const KNOWN = new Set([
  ...PREVIEWABLE, "application/zip", "application/json",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
export function safeContentType(raw: string) {
  const type = (raw.split(";")[0] ?? "").trim().toLowerCase();
  return KNOWN.has(type) ? type : "application/octet-stream";
}
/** Whether a viewer may show this inline at all. Everything else downloads. */
export const isPreviewable = (contentType: string) => PREVIEWABLE.has(contentType);
