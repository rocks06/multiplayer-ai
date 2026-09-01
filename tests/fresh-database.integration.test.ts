import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { migrate, baselineOf, declaredTables } from "../packages/db/src/migrator.js";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const { Pool } = pg;
const admin = process.env.DATABASE_URL;
if (!admin) throw new Error("DATABASE_URL is required for the fresh-database test");

/**
 * A genuinely empty database, migrated, checked against what the migrations say should exist.
 *
 * The previous migrator ran schema.sql and then recorded *every* migration as applied without
 * running any of them. schema.sql is a snapshot, so anything added after it was taken vanished on
 * every fresh database — and stayed vanished, because the record said it had been done. A hosted
 * deployment reported `Database initialized from latest schema` and then returned 500 from every
 * route that touched the missing table.
 *
 * Nothing about that is specific to 0009. This test therefore asks the migrations themselves what
 * they create, so it fails for the next one too rather than only the one that got caught.
 */
describe("initialising a database that has nothing in it", () => {
  const name = `mpai_fresh_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const url = new URL(admin);
  const target = new URL(admin);
  target.pathname = `/${name}`;
  let control: pg.Pool, pool: pg.Pool;

  beforeEach(async () => {
    control = new Pool({ connectionString: url.toString() });
    await control.query(`CREATE DATABASE ${name}`);
    pool = new Pool({ connectionString: target.toString() });
  });

  afterEach(async () => {
    await pool.end();
    await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await control.end();
  });

  const migrationFiles = async () => {
    const dir = resolve(process.cwd(), "packages/db/migrations");
    return (await readdir(dir)).filter(f => f.endsWith(".sql")).sort()
      .map(file => ({ file, path: resolve(dir, file) }));
  };

  it("ends with every table the migrations create, not just the ones in the snapshot", async () => {
    const result = await migrate(pool, process.cwd());
    expect(result.initialized).toBe(true);

    // Asked of the migrations, so a migration added tomorrow is covered without touching this.
    const missing: string[] = [];
    for (const { file, path } of await migrationFiles()) {
      for (const table of declaredTables(await readFile(path, "utf8"))) {
        const found = await pool.query(`SELECT to_regclass('public.'||$1) name`, [table]);
        if (!found.rows[0]?.name) missing.push(`${table} (${file})`);
      }
    }
    expect(missing).toEqual([]);
  });

  /** The table whose absence took the hosted deployment down. */
  it("has auth_rate_limits, and it works", async () => {
    await migrate(pool, process.cwd());
    const found = await pool.query(`SELECT to_regclass('public.auth_rate_limits') name`);
    expect(found.rows[0]?.name).toBe("auth_rate_limits");
    await pool.query(`INSERT INTO auth_rate_limits(bucket,window_start,count) VALUES('probe',now(),1)`);
    expect((await pool.query(`SELECT count FROM auth_rate_limits WHERE bucket='probe'`)).rows[0].count).toBe(1);
  });

  /**
   * The invariant that stops this recurring: a migration is recorded only when it has actually
   * been applied — either by this run, or by the snapshot that names it as its baseline.
   */
  it("records nothing it did not really apply", async () => {
    const result = await migrate(pool, process.cwd());
    const schema = await readFile(resolve(process.cwd(), "packages/db/schema.sql"), "utf8");
    const baseline = baselineOf(schema);
    const files = (await migrationFiles()).map(m => m.file);
    const after = files.slice(files.indexOf(baseline) + 1);

    // Everything past the baseline was applied for real on this run, not merely written down.
    expect(result.applied).toEqual(after);

    const recorded = (await pool.query<{ name: string }>(`SELECT name FROM schema_migrations ORDER BY name`)).rows.map(r => r.name);
    expect(recorded).toEqual(files);
  });

  /** Running it twice must be a no-op, not a second attempt at anything. */
  it("is idempotent", async () => {
    await migrate(pool, process.cwd());
    const again = await migrate(pool, process.cwd());
    expect(again).toMatchObject({ initialized: false, applied: [], repaired: [] });
  });

  /**
   * The exact hosted failure, reproduced: a record claiming a migration ran when its table is
   * absent. The migrator must treat that as the false claim it is and apply the migration, rather
   * than trusting the record and leaving the database broken for good.
   */
  it("repairs a migration that was recorded but never applied", async () => {
    await migrate(pool, process.cwd());
    await pool.query(`DROP TABLE auth_rate_limits`);
    // The record survives the table, which is precisely the state the old migrator produced.
    expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE name='0009_auth_rate_limits.sql'`)).rowCount).toBe(1);

    const repair = await migrate(pool, process.cwd());
    expect(repair.repaired).toContain("0009_auth_rate_limits.sql");
    expect(repair.applied).toContain("0009_auth_rate_limits.sql");
    expect((await pool.query(`SELECT to_regclass('public.auth_rate_limits') name`)).rows[0]?.name).toBe("auth_rate_limits");
  });

  /** An edited migration is still refused; repairing false claims must not weaken that. */
  it("still refuses a migration that changed after it was applied", async () => {
    await migrate(pool, process.cwd());
    await pool.query(`UPDATE schema_migrations SET checksum='tampered' WHERE name='0009_auth_rate_limits.sql'`);
    await expect(migrate(pool, process.cwd())).rejects.toThrow(/Applied migration changed/);
  });
});

describe("the baseline schema.sql declares", () => {
  it("is required, so nobody can forget to move it", () => {
    expect(() => baselineOf("CREATE TABLE x();")).toThrow(/baseline/);
  });

  it("is read from the file itself", async () => {
    const schema = await readFile(resolve(process.cwd(), "packages/db/schema.sql"), "utf8");
    expect(baselineOf(schema)).toMatch(/^\d{4}_.*\.sql$/);
  });

  it("finds the tables a migration creates, however it spells it", () => {
    expect(declaredTables("CREATE TABLE IF NOT EXISTS auth_rate_limits(a int);")).toEqual(["auth_rate_limits"]);
    expect(declaredTables("create table Foo(a int); CREATE TABLE bar(b int);").sort()).toEqual(["bar", "foo"]);
    expect(declaredTables("ALTER TABLE messages ADD COLUMN x int;")).toEqual([]);
  });
});
