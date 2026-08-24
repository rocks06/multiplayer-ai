import {hostname} from 'node:os';
import {createPool} from '../../api/src/db.js';
import {RoomService} from '../../api/src/room-service.js';
import {AgentRuntimeService} from '../../api/src/agent-runtime/runtime-service.js';
import {DeterministicFakeProvider} from '../../../packages/provider-fake/src/index.js';
import {AgentWorker} from './agent-worker.js';

const pool=createPool();
const rooms=new RoomService(pool);
const runtime=new AgentRuntimeService(pool,rooms);
const workerId=process.env.WORKER_ID??`${hostname()}:${process.pid}`;
const leaseMs=Number(process.env.AGENT_LEASE_MS??30_000);
const pollMs=Number(process.env.AGENT_POLL_MS??250);
const worker=new AgentWorker(runtime,new DeterministicFakeProvider(),{workerId,leaseMs});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{stopping=true});
console.log(`Agent worker ${workerId} started with deterministic fake provider`);
try{
 while(!stopping){
  try{const outcome=await worker.runOnce();if(outcome==='idle')await new Promise(resolve=>setTimeout(resolve,pollMs));}
  catch(error){console.error('Agent worker iteration failed',error);await new Promise(resolve=>setTimeout(resolve,pollMs));}
 }
} finally {await pool.end();console.log(`Agent worker ${workerId} stopped`)}
