import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";
import { safeContentType, safeFilename } from "../apps/api/src/artifacts/artifact-service.js";
import type { ArtifactStorage } from "../apps/api/src/artifacts/storage.js";

const { Pool } = pg;
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for artifact tests");

/** A store that remembers what it was asked to do, and can be told to fail. */
class RecordingStorage implements ArtifactStorage {
  readonly name = "recording";
  readonly objects = new Map<string, { body: Uint8Array; contentType: string }>();
  signed: Array<{ key: string; seconds: number }> = [];
  failNextPut = false;
  async put(key: string, body: Uint8Array, contentType: string) {
    if (this.failNextPut) { this.failNextPut = false; throw new Error("storage is down"); }
    this.objects.set(key, { body, contentType });
  }
  async signedUrl(key: string, seconds: number) {
    this.signed.push({ key, seconds });
    return `https://storage.example.test/${key}?token=signed&expires=${seconds}`;
  }
  async remove(key: string) { this.objects.delete(key); }
  async verify() {}
}

/**
 * Files a room holds, and who may touch them.
 *
 * One model for an agent's output and a person's upload, because they are the same thing to
 * everybody who later needs the file. Membership of the room is the only thing that grants access:
 * knowing an artifact's id is not access, and neither is belonging to the workspace it sits in.
 */
describe("artifacts in a room", () => {
  let pool: pg.Pool, app: ReturnType<typeof buildApp>, storage: RecordingStorage;
  const call = (method: string, url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({ method: method as any, url, payload: payload as any, headers });

  beforeEach(async () => {
    const bootstrap = new Pool({ connectionString });
    await truncateAll(bootstrap);
    await bootstrap.end();
    pool = new Pool({ connectionString });
    storage = new RecordingStorage();
    app = buildApp(pool, { pollIntervalMs: 20 },
      { allowHeaderPrincipal: true, artifactStorage: storage });
  });
  afterEach(async () => { await app.close(); });

  /** A room with a member in it, and somebody outside who is in the same workspace. */
  async function fixture() {
    const company = await seedCompany(pool, "Acme");
    const owner = await seedHuman(pool, company.id, `owner-${crypto.randomUUID()}@e.com`, "Owner");
    const other = await seedHuman(pool, company.id, `other-${crypto.randomUUID()}@e.com`, "Outsider");
    const head = { "x-principal-id": owner.principal_id };
    const project = (await call("POST", `/v1/companies/${company.id}/projects`,
      { name: "P", objective: "O" }, head)).json();
    const room = (await call("POST", `/v1/companies/${company.id}/projects/${project.id}/rooms`,
      { name: "TESTING #1" }, head)).json();
    return { company, owner, other, head, room };
  }

  const upload = (f: any, body: string, filename = "notes.pdf", type = "application/pdf",
                  as: Record<string, string> = f.head) =>
    call("POST",
      `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts?filename=${encodeURIComponent(filename)}&content_type=${encodeURIComponent(type)}`,
      body, { ...as, "content-type": "application/octet-stream" });

  it("stores a file, and reports it as this room's work", async () => {
    const f = await fixture();
    const created = await upload(f, "%PDF-1.4 pretend");
    expect(created.statusCode).toBe(200);
    expect(created.json().filename).toBe("notes.pdf");

    // The bytes went to the store, under a key built from ids rather than from the filename.
    expect(storage.objects.size).toBe(1);
    const [key] = [...storage.objects.keys()];
    expect(key).toBe(`companies/${f.company.id}/rooms/${f.room.id}/${created.json().id}`);
    expect(key).not.toContain("notes.pdf");

    const listed = await call("GET", `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts`, undefined, f.head);
    expect(listed.json().artifacts).toHaveLength(1);
    expect(listed.json().artifacts[0]).toMatchObject({
      filename: "notes.pdf", content_type: "application/pdf",
      creator_display_name: "Owner", previewable: true,
    });
  });

  /**
   * The file is not delivered until it is genuinely stored.
   *
   * Saying "done" for a file that never arrived is the failure this ordering exists to prevent:
   * the row is written first so a failure leaves something to find, and it is only ever shown once
   * the upload has actually returned.
   */
  it("does not report a file that failed to store", async () => {
    const f = await fixture();
    storage.failNextPut = true;
    const created = await upload(f, "bytes that never land");
    expect(created.statusCode).toBe(502);

    const listed = await call("GET", `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts`, undefined, f.head);
    expect(listed.json().artifacts).toEqual([]);
    // But the attempt is on record rather than silently forgotten.
    const rows = await pool.query(`SELECT status FROM artifacts`);
    expect(rows.rows.map(r => r.status)).toEqual(["failed"]);
  });

  it("hands out a short-lived link, and only after checking the room", async () => {
    const f = await fixture();
    const created = (await upload(f, "%PDF-1.4 pretend")).json();

    const link = await call("GET",
      `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts/${created.id}/download`, undefined, f.head);
    expect(link.statusCode).toBe(200);
    expect(link.json().url).toContain("token=signed");
    // Short enough that a leaked link is not worth passing on.
    expect(link.json().expires_in).toBeLessThanOrEqual(60);
    expect(storage.signed).toHaveLength(1);
  });

  describe("somebody who is not in the room", () => {
    it("cannot upload to it", async () => {
      const f = await fixture();
      const refused = await upload(f, "not mine", "sneak.pdf", "application/pdf",
        { "x-principal-id": f.other.principal_id });
      expect(refused.statusCode).toBe(403);
      expect(storage.objects.size).toBe(0);
    });

    it("cannot list or download from it, even knowing the id", async () => {
      const f = await fixture();
      const created = (await upload(f, "%PDF-1.4 pretend")).json();
      const outsider = { "x-principal-id": f.other.principal_id };

      expect((await call("GET", `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts`, undefined, outsider)).statusCode).toBe(403);
      const refused = await call("GET",
        `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts/${created.id}/download`, undefined, outsider);
      expect(refused.statusCode).toBe(403);
      // No link was minted, so nothing escaped for them to use later.
      expect(storage.signed).toHaveLength(0);
    });
  });

  it("refuses an empty file rather than delivering nothing", async () => {
    const f = await fixture();
    expect((await upload(f, "")).statusCode).toBeGreaterThanOrEqual(400);
  });
});

/**
 * What a filename and a content type are allowed to be.
 *
 * Both arrive from outside — an upload, or an agent that generated the file — and both end up in
 * front of a person. Neither is ever used to build a storage path.
 */
describe("names and types arriving from outside", () => {
  it("keeps an ordinary name intact", () => {
    expect(safeFilename("Miami_Golf_Courses.pdf")).toBe("Miami_Golf_Courses.pdf");
  });

  it("takes the path out of a name that is trying to be one", () => {
    expect(safeFilename("../../etc/passwd")).toBe("etcpasswd");
    expect(safeFilename("/absolute/thing.zip")).toBe("absolutething.zip");
    expect(safeFilename("..")).toBe("file");
    expect(safeFilename("   ")).toBe("file");
  });

  it("strips control characters that would disguise one name as another", () => {
    expect(safeFilename("report .pdf")).toBe("report.pdf");
  });

  /** A type decides whether a browser renders something. Anything unrecognised is bytes. */
  it("admits only types it knows, and never a scriptable one", () => {
    expect(safeContentType("application/pdf")).toBe("application/pdf");
    expect(safeContentType("image/png; charset=binary")).toBe("image/png");
    expect(safeContentType("application/zip")).toBe("application/zip");
    // Both of these run script when served inline from our own origin.
    expect(safeContentType("image/svg+xml")).toBe("application/octet-stream");
    expect(safeContentType("text/html")).toBe("application/octet-stream");
  });
});
