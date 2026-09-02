import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { migrate, baselineOf, declaredTables, declaredObjects, requiredObjects } from "../packages/db/src/migrator.js";
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

  /**
   * The incident this exists to prevent, reproduced exactly.
   *
   * Migration 0013 was recorded as applied while both of its unique indexes were absent. The
   * repair pass only ever looked for missing *tables*, so a migration whose whole contribution is
   * an index could sit there marked done with nothing to show for it, and the guarantee it was
   * supposed to add silently did not exist. Nothing noticed until a test tried to violate that
   * guarantee and succeeded — luck, not health checking.
   */
  it("re-applies a migration recorded as applied whose unique indexes are gone", async () => {
    await migrate(pool, process.cwd());
    await pool.query(`DROP INDEX external_agent_sessions_one_live`);
    await pool.query(`DROP INDEX external_agent_credentials_one_active`);
    expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE name='0013_one_live_binding.sql'`)).rowCount).toBe(1);

    const repair = await migrate(pool, process.cwd());
    expect(repair.repaired).toContain("0013_one_live_binding.sql");
    expect(repair.applied).toContain("0013_one_live_binding.sql");
    for (const index of ["external_agent_sessions_one_live", "external_agent_credentials_one_active"]) {
      expect((await pool.query(`SELECT to_regclass('public.'||$1) n`, [index])).rows[0].n).toBe(index);
    }
  });

  /**
   * Half present and half missing is not a migration that failed to run. It is a database
   * somebody has been inside, and re-running the migration could as easily finish the damage as
   * repair it, so it is named and refused rather than guessed at.
   */
  it("refuses to guess when a migration is only partly present", async () => {
    await migrate(pool, process.cwd());
    // The table 0009 created is still there; the index it created is not.
    await pool.query(`DROP INDEX auth_rate_limits_window_idx`);

    await expect(migrate(pool, process.cwd()))
      .rejects.toThrow(/0009_auth_rate_limits\.sql.*auth_rate_limits_window_idx/s);
    // Refusing means refusing: it did not half-run anything on the way out.
    expect((await pool.query(`SELECT 1 FROM schema_migrations WHERE name='0009_auth_rate_limits.sql'`)).rowCount).toBe(1);
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

describe("what a migration declares", () => {
  it("reads tables, named indexes and named constraints", () => {
    const actions = declaredObjects(`
      CREATE TABLE IF NOT EXISTS thing(id int);
      CREATE UNIQUE INDEX IF NOT EXISTS thing_one ON thing(id) WHERE id > 0;
      ALTER TABLE thing ADD CONSTRAINT thing_check CHECK (id > 0);`);
    expect(actions.map(a => `${a.action} ${a.kind} ${a.name}`)).toEqual([
      "create table thing", "create index thing_one", "create constraint thing_check",
    ]);
  });

  it("ignores statements that only alter an existing object", () => {
    expect(declaredObjects("ALTER TABLE thing ADD COLUMN extra text;")).toEqual([]);
  });

  /**
   * A migration that replaces an object in place proves nothing by that object. The constraint is
   * present whether or not the migration ran, because it was there beforehand — which is exactly
   * how 0013 looked: its two CHECK constraints were older than it, and only its indexes were
   * really its own. Counting a replacement as proof condemns every healthy database that upgraded
   * from the snapshot.
   */
  it("takes no proof from an object a migration only replaces", () => {
    const required = requiredObjects([{ name: "0001.sql", sql: `
      ALTER TABLE t DROP CONSTRAINT t_check;
      ALTER TABLE t ADD CONSTRAINT t_check CHECK (x > 0);` }]);
    expect(required.get("0001.sql")).toBeUndefined();
  });

  /** Order still decides ownership: a plain create after an earlier migration's drop is proof. */
  it("credits the migration that last created an object", () => {
    const required = requiredObjects([
      { name: "0001.sql", sql: "CREATE UNIQUE INDEX one ON t(a);" },
      { name: "0002.sql", sql: "DROP INDEX one;" },
      { name: "0003.sql", sql: "CREATE UNIQUE INDEX one ON t(a,b);" },
    ]);
    expect(required.get("0001.sql")).toBeUndefined();
    expect(required.get("0003.sql")).toEqual([{ kind: "index", name: "one" }]);
  });

  /** An object a later migration removes belongs to nobody, and is required by nobody. */
  it("stops requiring an object once a later migration drops it", () => {
    const required = requiredObjects([
      { name: "0001.sql", sql: "CREATE UNIQUE INDEX old_idx ON t(a);" },
      { name: "0002.sql", sql: "DROP INDEX IF EXISTS old_idx;" },
    ]);
    expect(required.get("0001.sql")).toBeUndefined();
  });
});
