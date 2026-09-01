import pg from 'pg';
import {migrate} from './migrator.js';

const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required');
const pool=new pg.Pool({connectionString:url});
try{
 const result=await migrate(pool);
 if(result.initialized)console.log('Database initialized from schema.sql');
 for(const name of result.repaired)console.log(`Repaired ${name}: recorded as applied but its tables were absent`);
 for(const name of result.applied)console.log(`Applied ${name}`);
 if(!result.initialized&&!result.applied.length&&!result.repaired.length)console.log('Database already up to date');
}finally{await pool.end()}
