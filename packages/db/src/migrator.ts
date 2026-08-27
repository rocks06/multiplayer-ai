import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Pool } from "pg";

export interface MigrationResult {
  /** True when the database was empty and was created from the current schema. */
  initialized: boolean;
  applied: string[];
}

/**
 * The one ordered path a database reaches the current schema by. A fresh database is created
 * from schema.sql and every migration is recorded as already applied; an existing database
 * receives only the migrations it has not seen, in filename order, each in its own
 * transaction. Applied migrations are checksummed so an edited migration is refused rather
 * than silently diverging.
 *
 * Tests use this too. Loading schema.sql directly cannot retrofit an ALTER onto a table that
 * already exists, which silently skips column-adding migrations.
 */
export async function migrate(pool: Pool, root = process.cwd()): Promise<MigrationResult> {
  const schemaPath = resolve(root, "packages/db/schema.sql");
  const migrationDir = resolve(root, "packages/db/migrations");
  const files = (await readdir(migrationDir)).filter(name => name.endsWith(".sql")).sort();
  const initialized = Boolean((await pool.query(`SELECT to_regclass('public.companies') name`)).rows[0]?.name);
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);

  if (!initialized) {
    await pool.query(await readFile(schemaPath, "utf8"));
    for (const name of files) {
      const sql = await readFile(resolve(migrationDir, name), "utf8");
      await pool.query(`INSERT INTO schema_migrations(name,checksum) VALUES($1,$2) ON CONFLICT(name) DO NOTHING`, [name, createHash("sha256").update(sql).digest("hex")]);
    }
    return { initialized: true, applied: [] };
  }

  const applied: string[] = [];
  for (const name of files) {
    const sql = await readFile(resolve(migrationDir, name), "utf8");
    const checksum = createHash("sha256").update(sql).digest("hex");
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
  return { initialized: false, applied };
}
