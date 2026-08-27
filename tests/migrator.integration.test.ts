import { afterEach, beforeEach, describe, expect, it } from "vitest";
import pg from "pg";
import { mkdtemp, mkdir, writeFile, cp } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../packages/db/src/migrator.js";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required for migrator tests");

const maintenanceUrl = () => { const url = new URL(connectionString); url.pathname = "/postgres"; return url.toString(); };

describe("Database migrator", () => {
  let admin: pg.Pool, scratchName: string, scratchUrl: string, roots: string[] = [];

  beforeEach(async () => {
    admin = new pg.Pool({ connectionString: maintenanceUrl() });
    scratchName = `mpai_migrator_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    await admin.query(`CREATE DATABASE ${scratchName}`);
    const url = new URL(connectionString); url.pathname = `/${scratchName}`; scratchUrl = url.toString();
  });
  afterEach(async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${scratchName} WITH (FORCE)`).catch(() => {});
    await admin.end();
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots = [];
  });

  const connect = () => new pg.Pool({ connectionString: scratchUrl });

  it("initializes an empty database and records every migration as applied", async () => {
    const pool = connect();
    try {
      const result = await migrate(pool);
      expect(result.initialized).toBe(true);
      expect(result.applied).toEqual([]);
      const recorded = await pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`);
      expect(recorded.rows.map(r => r.name)).toContain("0007_task_dependencies.sql");
      // The schema is complete, including columns only an ALTER migration adds.
      const columns = await pool.query(`SELECT 1 FROM information_schema.columns WHERE table_name='tasks' AND column_name='dependency_override_at'`);
      expect(columns.rowCount).toBe(1);
    } finally { await pool.end(); }
  });

  it("is a no-op on replay", async () => {
    const pool = connect();
    try {
      await migrate(pool);
      const before = await pool.query(`SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name`);
      const second = await migrate(pool);
      expect(second).toEqual({ initialized: false, applied: [] });
      const after = await pool.query(`SELECT name,checksum,applied_at FROM schema_migrations ORDER BY name`);
      expect(after.rows).toEqual(before.rows);
    } finally { await pool.end(); }
  });

  /** A copy of the real repository, optionally with an extra migration appended. */
  async function repoWith(extra?: { name: string; sql: string }) {
    const root = await mkdtemp(join(tmpdir(), "mpai-migrator-"));
    roots.push(root);
    await mkdir(join(root, "packages/db/migrations"), { recursive: true });
    await cp("packages/db/schema.sql", join(root, "packages/db/schema.sql"));
    const { readdir } = await import("node:fs/promises");
    for (const name of (await readdir("packages/db/migrations")).sort()) {
      await cp(join("packages/db/migrations", name), join(root, "packages/db/migrations", name));
    }
    if (extra) await writeFile(join(root, "packages/db/migrations", extra.name), extra.sql);
    return root;
  }

  it("applies only the migrations an existing database has not seen", async () => {
    const pool = connect();
    try {
      await migrate(pool);
      // A migration that appears after this database was built. Asserting the mechanism rather
      // than a specific file keeps the test from rotting every time a migration is added.
      const withNew = await repoWith({ name: "9999_probe.sql", sql: "CREATE TABLE migrator_probe(id integer PRIMARY KEY);\n" });
      const upgraded = await migrate(pool, withNew);
      expect(upgraded.initialized).toBe(false);
      expect(upgraded.applied).toEqual(["9999_probe.sql"]);
      expect((await pool.query(`SELECT 1 FROM pg_tables WHERE tablename='migrator_probe'`)).rowCount).toBe(1);

      // Already-seen migrations are never re-run.
      expect((await migrate(pool, withNew)).applied).toEqual([]);
    } finally { await pool.end(); }
  });

  it("rolls a failing migration back rather than half-applying it", async () => {
    const pool = connect();
    try {
      await migrate(pool);
      const broken = await repoWith({ name: "9999_broken.sql", sql: "CREATE TABLE migrator_ok(id integer PRIMARY KEY);\nSELECT 1/0;\n" });
      await expect(migrate(pool, broken)).rejects.toThrow();
      // Neither the table nor the bookkeeping row survives a failed migration.
      expect((await pool.query(`SELECT 1 FROM pg_tables WHERE tablename='migrator_ok'`)).rowCount).toBe(0);
      expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE name='9999_broken.sql'`)).rowCount).toBe(0);
    } finally { await pool.end(); }
  });

  it("refuses a migration that changed after it was applied", async () => {
    const pool = connect();
    try {
      await migrate(pool);
      const tampered = await repoWith();
      await writeFile(join(tampered, "packages/db/migrations/0007_task_dependencies.sql"), "-- edited after the fact\nSELECT 1;\n");
      // Silent divergence between a deployed schema and its recorded history is worse than
      // a hard failure, so an edited migration must stop the run.
      await expect(migrate(pool, tampered)).rejects.toThrow(/Applied migration changed: 0007_task_dependencies\.sql/);
    } finally { await pool.end(); }
  });
});
