import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";
import { safeContentType, safeFilename } from "../apps/api/src/artifacts/artifact-service.js";
import type { ArtifactStorage } from "../apps/api/src/artifacts/storage.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HermesAdapter } from "../packages/connector-hermes/src/index.js";

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

  /**
   * The whole point, from an agent's side.
   *
   * An agent that says "saved to /Users/.../report.pdf" has delivered nothing: nobody on another
   * machine can open that, and it goes away with the laptop. The session already names the company,
   * the room and the agent, so an agent can only ever put a file in the room it is connected to.
   */
  describe("an agent delivering what it made", () => {
    async function connected(f: any) {
      const agent = (await call("POST", `/v1/companies/${f.company.id}/agents`, { name: "Research" }, f.head)).json();
      await call("POST", `/v1/companies/${f.company.id}/rooms/${f.room.id}/members`,
        { principal_id: agent.principal_id, role: "worker_agent", responsibilities: "" },
        { ...f.head, "idempotency-key": crypto.randomUUID() });
      const credential = (await call("POST",
        `/v1/companies/${f.company.id}/agents/${agent.principal_id}/gateway-credentials`,
        { label: "its Mac" }, f.head)).json();
      const session = (await call("POST", "/v1/agent-gateway/v1/sessions", { room_id: f.room.id },
        { authorization: `Bearer ${credential.credential_token}` })).json();
      return { agent, session, auth: { authorization: `Bearer ${session.session_token}` } };
    }

    it.each(['success', 'missing', 'upload-failure', 'no-message', 'explicit'])("fake Hermes process -> real authenticated gateway: %s", async mode => {
      const f = await fixture();
      const jj = await connected(f);
      const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 });
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mpai-artifact-test-'));
      const binary = path.join(root, 'fake-hermes');
      const key = crypto.randomUUID();
      const bytes = '%PDF-1.4\n1 0 obj <</Type /Catalog>> endobj\n%%EOF\n';
      const session = Buffer.from(JSON.stringify({ baseUrl, roomId: f.room.id, agentPrincipalId: jj.agent.principal_id, sessionId: jj.session.session_id, sessionToken: jj.session.session_token })).toString('base64');
      // Labeled fake runtime; no model, user's Hermes, profile, or production connection is used.
      fs.writeFileSync(binary, `#!/usr/bin/env node
const fs = require('node:fs'), cp = require('node:child_process');
if (process.argv.includes('--version')) { console.log('Hermes v0.18.0'); process.exit(0); }
const output = JSON.parse(process.env.MPAI_GENERATED_OUTPUT);
fs.writeFileSync(output.manifest, JSON.stringify({expected:['report.pdf']}));
if (${JSON.stringify(mode)} !== 'missing') fs.writeFileSync(output.directory+'/report.pdf', ${JSON.stringify(bytes)});
if (${JSON.stringify(mode)} === 'no-message') process.exit(0);
const env = {...process.env, MPAI_SESSION:${JSON.stringify(session)}, MPAI_SUPPORT_DIR:${JSON.stringify(root)}, MPAI_IDENTITY_DIR:${JSON.stringify(root)}};
const sidecar = ${JSON.stringify(path.resolve('apps/connector-macos/sidecar/sidecar.mjs'))};
if (${JSON.stringify(mode)} === 'explicit') {
 const attached = cp.spawnSync(process.execPath, [sidecar,'attach','--file',output.directory+'/report.pdf'], {env,encoding:'utf8'});
 if (attached.status !== 0) process.exit(1);
}
const result = cp.spawnSync(process.execPath, [sidecar,'message','--body','Generated PDF','--key',${JSON.stringify(key)}], {env,encoding:'utf8'});
console.log(result.stdout, result.stderr);
process.exit(result.status ?? 1);
`, { mode: 0o700 });
      const adapter = new HermesAdapter({ command: binary });
      const input = { profile: 'isolated-test', roomId: f.room.id, agentPrincipalId: jj.agent.principal_id, trigger: [], assignedTasks: [], commandSurface: { template: 'sidecar COMMAND', verbs: ['message', 'attach'] }, logPath: path.join(root, 'test.log') };
      try {
        if (mode === 'upload-failure') storage.failNextPut = true;
        const result = await adapter.invoke(input);
        const success = mode === 'success' || mode === 'explicit';
        expect(result.ok, fs.readFileSync(input.logPath, 'utf8')).toBe(success);
        if (mode === 'success' || mode === 'upload-failure') expect((await adapter.invoke(input)).ok).toBe(success);
        const rows = await pool.query('SELECT count(*)::int n FROM message_artifacts');
        expect(rows.rows[0].n).toBe(success ? 1 : 0);
        expect(storage.objects.size).toBe(success ? 1 : 0);
        if (success) {
          expect(Buffer.from([...storage.objects.values()][0]!.body).toString()).toBe(bytes);
          const snapshot = (await call('GET', `/v1/companies/${f.company.id}/rooms/${f.room.id}/snapshot`, undefined, f.head)).json();
          expect(snapshot.messages.filter((m: any) => m.body_text === 'Generated PDF')).toHaveLength(1);
          expect(snapshot.messages.find((m: any) => m.body_text === 'Generated PDF').attachments[0].filename).toBe('report.pdf');
        }
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    });

    it("uploads a file and delivers it with one message", async () => {
      const f = await fixture();
      const jj = await connected(f);

      const uploaded = await call("POST",
        `/v1/agent-gateway/v1/sessions/${jj.session.session_id}/artifacts?filename=${encodeURIComponent("Golf_Courses.pdf")}&content_type=application%2Fpdf`,
        "%PDF-1.4 the real thing", { ...jj.auth, "content-type": "application/octet-stream" });
      expect(uploaded.statusCode).toBe(200);

      const said = await call("POST", `/v1/agent-gateway/v1/sessions/${jj.session.session_id}/messages`,
        { body: "Here is the research.", artifact_ids: [uploaded.json().id] },
        { ...jj.auth, "idempotency-key": crypto.randomUUID() });
      expect(said.statusCode).toBe(200);

      // The room's own view carries the file, so nothing has to be fetched per message to show it.
      const snapshot = (await call("GET", `/v1/companies/${f.company.id}/rooms/${f.room.id}/snapshot`,
        undefined, f.head)).json();
      const delivered = snapshot.messages.find((m: any) => m.body_text === "Here is the research.");
      expect(delivered.attachments).toHaveLength(1);
      expect(delivered.attachments[0]).toMatchObject({ filename: "Golf_Courses.pdf", content_type: "application/pdf" });
      // And a person in the room can open it, which is what delivery means.
      const link = await call("GET",
        `/v1/companies/${f.company.id}/rooms/${f.room.id}/artifacts/${uploaded.json().id}/download`, undefined, f.head);
      expect(link.statusCode).toBe(200);
    });

    /** Sending the same message twice must not put the file in the room twice. */
    it("does not deliver the same file twice on a retry", async () => {
      const f = await fixture();
      const jj = await connected(f);
      const uploaded = (await call("POST",
        `/v1/agent-gateway/v1/sessions/${jj.session.session_id}/artifacts?filename=r.pdf&content_type=application%2Fpdf`,
        "%PDF-1.4", { ...jj.auth, "content-type": "application/octet-stream" })).json();

      const key = crypto.randomUUID();
      const send = () => call("POST", `/v1/agent-gateway/v1/sessions/${jj.session.session_id}/messages`,
        { body: "Here it is.", artifact_ids: [uploaded.id] }, { ...jj.auth, "idempotency-key": key });
      await send();
      await send();

      const rows = await pool.query(`SELECT count(*)::int n FROM message_artifacts`);
      expect(rows.rows[0].n).toBe(1);
      const messages = await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='Here it is.'`);
      expect(messages.rows[0].n).toBe(1);
    });

    /** A file from another room cannot be smuggled into this one by id. */
    it("refuses to attach a file that is not this room's", async () => {
      const f = await fixture();
      const jj = await connected(f);
      const elsewhere = (await call("POST", `/v1/companies/${f.company.id}/projects`, { name: "P2", objective: "O" }, f.head)).json();
      const otherRoom = (await call("POST", `/v1/companies/${f.company.id}/projects/${elsewhere.id}/rooms`, { name: "Other" }, f.head)).json();
      const theirs = (await call("POST",
        `/v1/companies/${f.company.id}/rooms/${otherRoom.id}/artifacts?filename=secret.pdf&content_type=application%2Fpdf`,
        "%PDF-1.4 not yours", { ...f.head, "content-type": "application/octet-stream" })).json();

      const refused = await call("POST", `/v1/agent-gateway/v1/sessions/${jj.session.session_id}/messages`,
        { body: "Look at this.", artifact_ids: [theirs.id] },
        { ...jj.auth, "idempotency-key": crypto.randomUUID() });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect((await pool.query(`SELECT count(*)::int n FROM message_artifacts`)).rows[0].n).toBe(0);
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
