import {createHash} from 'node:crypto';
import {readdir,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import pg from 'pg';

const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required');
const pool=new pg.Pool({connectionString:url});
const schemaPath=resolve('packages/db/schema.sql');
const migrationDir=resolve('packages/db/migrations');
const files=(await readdir(migrationDir)).filter(name=>name.endsWith('.sql')).sort();
const initialized=Boolean((await pool.query(`SELECT to_regclass('public.companies') name`)).rows[0]?.name);
if(!initialized){
 await pool.query(await readFile(schemaPath,'utf8'));
 await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
 for(const name of files){const sql=await readFile(resolve(migrationDir,name),'utf8');const checksum=createHash('sha256').update(sql).digest('hex');await pool.query(`INSERT INTO schema_migrations(name,checksum) VALUES($1,$2) ON CONFLICT(name) DO NOTHING`,[name,checksum])}
 console.log('Database initialized from latest schema');
}else{
 await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`);
 for(const name of files){
  const sql=await readFile(resolve(migrationDir,name),'utf8');const checksum=createHash('sha256').update(sql).digest('hex');
  const prior=await pool.query<{checksum:string}>(`SELECT checksum FROM schema_migrations WHERE name=$1`,[name]);
  if(prior.rowCount){if(prior.rows[0]!.checksum!==checksum)throw new Error(`Applied migration changed: ${name}`);continue}
  const client=await pool.connect();try{await client.query('BEGIN');await client.query(sql);await client.query(`INSERT INTO schema_migrations(name,checksum) VALUES($1,$2)`,[name,checksum]);await client.query('COMMIT');console.log(`Applied ${name}`)}catch(error){await client.query('ROLLBACK');throw error}finally{client.release()}
 }
}
await pool.end();
