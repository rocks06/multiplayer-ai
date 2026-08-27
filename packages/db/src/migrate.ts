import pg from 'pg';
import {migrate} from './migrator.js';

const url=process.env.DATABASE_URL;if(!url)throw new Error('DATABASE_URL is required');
const pool=new pg.Pool({connectionString:url});
try{
 const result=await migrate(pool);
 if(result.initialized)console.log('Database initialized from latest schema');
 for(const name of result.applied)console.log(`Applied ${name}`);
}finally{await pool.end()}
