import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

export interface MigrationResult {
  /** True when the database was empty and was built from schema.sql plus later migrations. */
  initialized: boolean;
  applied: string[];
  /** Migrations that claimed to have been applied but whose tables were absent. */
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

/**
 * The tables a migration creates, read from the migration itself.
 *
 * Used to tell a migration that ran from one that was merely recorded. It is deliberately only
 * about tables: that is what can be checked cheaply and unambiguously, and a migration that only
 * alters an existing table is left alone rather than guessed at.
 */
export function declaredTables(sql: string): string[] {
  const names = new Set<string>();
  for (const match of sql.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi)) {
    names.add(match[1]!.toLowerCase());
  }
  return [...names];
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

  const repaired = fresh ? [] : await removeFalseClaims(pool, files, read);

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
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  return { initialized: fresh, applied, repaired };
}

/**
 * Drop records for migrations that plainly never ran.
 *
 * A database created by the previous version carries a full set of applied records regardless of
 * what it actually received. Where every table a migration creates is absent, the record is a
 * false claim and nothing else: removing it lets this run apply the migration properly. A
 * migration whose tables are only *partly* missing is left alone — that is a different and much
 * more alarming situation, and re-running it blindly could make it worse.
 */
async function removeFalseClaims(
  pool: Pool, files: string[], read: (name: string) => Promise<string>,
): Promise<string[]> {
  const repaired: string[] = [];
  for (const name of files) {
    const recorded = await pool.query(`SELECT 1 FROM schema_migrations WHERE name=$1`, [name]);
    if (!recorded.rowCount) continue;
    const tables = declaredTables(await read(name));
    if (!tables.length) continue;
    const present = await pool.query<{ name: string | null }>(
      `SELECT to_regclass('public.'||t) name FROM unnest($1::text[]) t`, [tables]);
    if (present.rows.some(row => row.name)) continue;
    await pool.query(`DELETE FROM schema_migrations WHERE name=$1`, [name]);
    repaired.push(name);
  }
  return repaired;
}
