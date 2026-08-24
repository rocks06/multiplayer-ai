import * as pg from "pg";
const { Pool } = pg;

export function createPool(connectionString = process.env.DATABASE_URL) {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  return new Pool({ connectionString });
}
export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
