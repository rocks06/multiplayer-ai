import type { Pool } from "pg";

/**
 * Clear every application table. The list is read from the database rather than hand-written,
 * so a new table can never be silently left behind by one suite's stale truncate list.
 */
export async function truncateAll(pool: Pool) {
  const tables = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> 'schema_migrations'`,
  );
  if (!tables.rowCount) return;
  await pool.query(`TRUNCATE ${tables.rows.map(row => `"${row.tablename}"`).join(",")} CASCADE`);
}
