import pg from "pg";
import { migrate } from "../../packages/db/src/migrator.js";

/** Bring the test database to the current schema through the deployment migration path. */
export default async function setup() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required for integration tests");
  const pool = new pg.Pool({ connectionString });
  try { await migrate(pool); } finally { await pool.end(); }
}
