import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

export interface MigrationResult {
  /** True when the database was empty and was built from schema.sql plus later migrations. */
  initialized: boolean;
  applied: string[];
  /** Migrations that claimed to have been applied while nothing they create existed. */
  repaired: string[];
}

/** The migration schema.sql already contains. Everything after it is applied on top. */
const BASELINE = /^--\s*baseline:\s*(\S+)\s*$/m;

export function baselineOf(schema: string): string {
  const found = BASELINE.exec(schema);
  if (!found) {
    throw new Error(
      "packages/db/schema.sql must begin with `-- baseline: <migration file>` naming how far it "
      + "reaches. Without it a fresh database cannot be told which migrations it still needs.");
  }
  return found[1]!;
}

/** A schema object a migration brings into being, or takes away. */
export type ObjectKind = "table" | "index" | "constraint";
export interface DeclaredObject { kind: ObjectKind; name: string }
export interface ObjectAction extends DeclaredObject { action: "create" | "drop" }

/* Written as one alternation so the matches come back in source order, which is what makes
   drop-then-recreate inside a single file resolve correctly. */
const DECLARATION =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)|CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][\w]*)|ADD\s+CONSTRAINT\s+([A-Za-z_][\w]*)|DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)|DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)|DROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?([A-Za-z_][\w]*)/gi;

/**
 * The schema objects a migration declares, in the order it declares them.
 *
 * Used to tell a migration that ran from one that was merely recorded. It covers tables, named
 * indexes and named constraints — the things a migration names, and which can therefore be
 * looked up afterwards by that name. Statements that only alter an existing object (adding a
 * column, changing a default) declare nothing here and are left alone rather than guessed at.
 *
 * Order matters and is preserved: a migration that drops a constraint and adds one back under
 * the same name ends with it present, and reading the two statements as unordered sets would
 * conclude the opposite.
 */
export function declaredObjects(sql: string): ObjectAction[] {
  const found: ObjectAction[] = [];
  for (const m of sql.matchAll(DECLARATION)) {
    if (m[1]) found.push({ action: "create", kind: "table", name: m[1].toLowerCase() });
    else if (m[2]) found.push({ action: "create", kind: "index", name: m[2].toLowerCase() });
    else if (m[3]) found.push({ action: "create", kind: "constraint", name: m[3].toLowerCase() });
    else if (m[4]) found.push({ action: "drop", kind: "table", name: m[4].toLowerCase() });
    else if (m[5]) found.push({ action: "drop", kind: "index", name: m[5].toLowerCase() });
    else if (m[6]) found.push({ action: "drop", kind: "constraint", name: m[6].toLowerCase() });
  }
  return found;
}

/** Kept for callers that only care about tables. */
export function declaredTables(sql: string): string[] {
  return [...new Set(declaredObjects(sql)
    .filter(o => o.action === "create" && o.kind === "table").map(o => o.name))];
}

/**
 * What each migration is answerable for, once the whole history has been read.
 *
 * An object belongs to the migration that last created it, and to nothing at all if a later
 * migration took it away again. Attributing on creation alone would make every migration that
 * builds something later replaced look permanently broken — and re-running it would then undo
 * the replacement. This is walked in file order, and within a file in statement order.
 */
export function requiredObjects(files: Array<{ name: string; sql: string }>): Map<string, DeclaredObject[]> {
  const owner = new Map<string, { migration: string; object: DeclaredObject }>();
  for (const file of files) {
    /* An object this migration drops before creating is one that already existed: 0013 replaces
       external_agent_sessions_status_check, and that constraint is present whether or not 0013
       ever ran. Only an object the migration brings into being for the first time is evidence
       that it ran, so a replacement is owned by nobody and proves nothing. */
    const replaced = new Set<string>();
    for (const action of declaredObjects(file.sql)) {
      const key = `${action.kind}:${action.name}`;
      if (action.action === "drop") { owner.delete(key); replaced.add(key); continue; }
      if (replaced.has(key)) continue;
      owner.set(key, { migration: file.name, object: { kind: action.kind, name: action.name } });
    }
  }
  const byMigration = new Map<string, DeclaredObject[]>();
  for (const { migration, object } of owner.values()) {
    byMigration.set(migration, [...(byMigration.get(migration) ?? []), object]);
  }
  return byMigration;
}

/**
 * The one ordered path a database reaches the current schema by.
 *
 * An empty database is built from schema.sql, which is a snapshot of the history up to the
 * migration it names as its baseline; every migration after that is then applied for real. This
 * replaces a version that ran schema.sql and then recorded *every* migration as applied without
 * running any of them — so anything added since the snapshot was taken was lost on every fresh
 * database, permanently, and invisibly, because the record said it had been done.
 *
 * An existing database receives only what it has not seen, in filename order, each in its own
 * transaction, with applied migrations checksummed so an edited one is refused rather than
 * silently diverging. Before that, a record whose tables are absent is treated as the false claim
 * it is and removed, so the migration is applied properly on this run.
 */
export async function migrate(pool: Pool, root = process.cwd()): Promise<MigrationResult> {
  const schemaPath = resolve(root, "packages/db/schema.sql");
  const migrationDir = resolve(root, "packages/db/migrations");
  const files = (await readdir(migrationDir)).filter(name => name.endsWith(".sql")).sort();
  const schema = await readFile(schemaPath, "utf8");
  const baseline = baselineOf(schema);
  if (!files.includes(baseline)) {
    throw new Error(`schema.sql names ${baseline} as its baseline, and no such migration exists.`);
  }

  const read = async (name: string) => await readFile(resolve(migrationDir, name), "utf8");
  const digest = (sql: string) => createHash("sha256").update(sql).digest("hex");

  const fresh = !(await pool.query(`SELECT to_regclass('public.companies') name`)).rows[0]?.name;
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);

  if (fresh) {
    await pool.query(schema);
    // Only what the snapshot actually contains is recorded. The rest is applied below, for real.
    for (const name of files.slice(0, files.indexOf(baseline) + 1)) {
      await pool.query(
        `INSERT INTO schema_migrations(name,checksum) VALUES($1,$2) ON CONFLICT(name) DO NOTHING`,
        [name, digest(await read(name))]);
    }
  }

  const loaded = await Promise.all(files.map(async name => ({ name, sql: await read(name) })));
  const health = fresh ? { repaired: [], damaged: [] } : await removeFalseClaims(pool, loaded, baseline);
  if (health.damaged.length) {
    /* Refused for the same reason an edited migration is refused: a schema that has silently
       diverged from its own history is worse than a run that stops and says so. */
    throw new Error(
      `Database is missing objects from migrations recorded as applied: ${health.damaged.join("; ")}. `
      + "This was not a migration that failed to run, so it is not repaired automatically.");
  }
  const repaired = health.repaired;

  const applied: string[] = [];
  for (const name of files) {
    const sql = await read(name);
    const checksum = digest(sql);
    const prior = await pool.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE name=$1`, [name]);
    if (prior.rowCount) {
      if (prior.rows[0]!.checksum !== checksum) throw new Error(`Applied migration changed: ${name}`);
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)`, [name, checksum]);
      await client.query("COMMIT");
      applied.push(name);
    } catch (error) {
      await client.query("ROLLBACK");
      /* A repaired migration is being run against a database that already has some of it, which a
         migration written to run once may not survive. Saying which case this is turns a bare
         Postgres error into something an operator can act on. */
      if (repaired.includes(name)) {
        throw new Error(
          `${name} was recorded as applied, its objects were absent, and re-applying it failed: `
          + `${(error as Error).message}. The database needs looking at by hand.`,
          { cause: error });
      }
      throw error;
    } finally { client.release(); }
  }
  return { initialized: fresh, applied, repaired };
}

/**
 * Drop records for migrations that plainly never ran.
 *
 * A database created by the previous version carries a full set of applied records regardless of
 * what it actually received. Where every object a migration brings into being is absent — tables,
 * but also the indexes and constraints that are often a migration's entire contribution — the
 * record is a false claim and nothing else: removing it lets this run apply the migration
 * properly. Checking tables alone was how 0013 came to be recorded as applied while the two
 * unique indexes that were its whole purpose did not exist, which nothing noticed until a test
 * violated the guarantee they were supposed to make.
 *
 * A migration whose objects are only *partly* missing is reported, never repaired. That is not a
 * migration that failed to run; it is a database somebody has been inside, and re-running it
 * blindly could as easily finish the damage as undo it.
 */
async function removeFalseClaims(
  pool: Pool, files: Array<{ name: string; sql: string }>, baseline: string,
): Promise<{ repaired: string[]; damaged: string[] }> {
  const required = requiredObjects(files);
  /* Only migrations after the snapshot are answerable for their own objects. Everything up to the
     baseline was never run — schema.sql built those tables directly — and schema.sql expresses the
     same guarantees inline, so Postgres names them differently. `messages_company_room_id_key` in
     a migration is `messages_company_id_room_id_id_key` from an inline UNIQUE: the same constraint
     wearing a different name, and treating that as a missing object would condemn every fresh
     database as damaged. */
  const after = files.slice(files.findIndex(f => f.name === baseline) + 1).map(f => f.name);
  const repaired: string[] = [], damaged: string[] = [];

  for (const file of files) {
    if (!after.includes(file.name)) continue;
    const objects = required.get(file.name);
    if (!objects?.length) continue;
    const recorded = await pool.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [file.name]);
    if (!recorded.rowCount) continue;

    const missing: DeclaredObject[] = [];
    for (const object of objects) {
      if (!(await exists(pool, object))) missing.push(object);
    }
    if (!missing.length) continue;

    if (missing.length === objects.length) {
      /* Nothing it declared is there, so it never ran. The record is a claim and nothing else:
         removing it lets this run apply the migration properly. */
      await pool.query(`DELETE FROM schema_migrations WHERE name=$1`, [file.name]);
      repaired.push(file.name);
      continue;
    }
    /* Some of it is there and some is not. That is not a migration which failed to run — it is a
       database somebody or something has been inside, and re-running the migration could as
       easily finish the damage as repair it. It is named and refused rather than guessed at. */
    damaged.push(`${file.name} (missing ${missing.map(o => `${o.kind} ${o.name}`).join(", ")})`);
  }
  return { repaired, damaged };
}

/** Whether one declared object is actually in the database. */
async function exists(pool: Pool, object: DeclaredObject): Promise<boolean> {
  if (object.kind === "constraint") {
    const found = await pool.query(`SELECT 1 FROM pg_constraint WHERE conname=$1`, [object.name]);
    return Boolean(found.rowCount);
  }
  // Tables and indexes are both relations, so one lookup answers for both.
  const found = await pool.query<{ name: string | null }>(
    `SELECT to_regclass('public.'||$1) AS name`, [object.name]);
  return Boolean(found.rows[0]?.name);
}
