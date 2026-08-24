import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import * as pg from "pg";

const { Pool } = pg;
const schemaPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../schema.sql");
const sql = await readFile(schemaPath, "utf8");
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  await pool.query(sql);
  console.log("Database schema applied");
} finally {
  await pool.end();
}
