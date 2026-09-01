import * as pg from 'pg';
import {buildApp} from '../../apps/api/src/app.js';
import type {SignInLink,SignInLinkDelivery} from '../../apps/api/src/auth/auth-service.js';
import {RoomService} from '../../apps/api/src/room-service.js';
import {AgentRuntimeService} from '../../apps/api/src/agent-runtime/runtime-service.js';
import {AgentWorker} from '../../apps/worker/src/agent-worker.js';
import {DeterministicFakeProvider,type FakeScript} from '../../packages/provider-fake/src/index.js';
import {migrate} from '../../packages/db/src/migrator.js';
import {truncateAll} from '../support/database.js';

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error('DATABASE_URL is required for the browser fixture');
const pool=new Pool({connectionString});
const rooms=new RoomService(pool);const runtime=new AgentRuntimeService(pool,rooms);
await migrate(pool);
await truncateAll(pool);
const company=await rooms.createCompany('Multiplayer Studio');
const alex=await rooms.createHuman(company.id,'alex@multiplayer.local','Alex Morgan');
const sarah=await rooms.createHuman(company.id,'sarah@multiplayer.local','Sarah Chen');
const project=await rooms.createProject(company.id,alex.principal_id,'Atlas launch','Prepare a verified launch brief and coordinate publication with human authority.');
const room=await rooms.createRoom(company.id,project.id,alex.principal_id,'Launch room','Direct the work, verify claims, and authorize publication.');
await rooms.addMember({companyId:company.id,roomId:room.id,actorId:alex.principal_id,principalId:sarah.principal_id,role:'contributor',responsibilities:'Review customer evidence',idempotencyKey:'add-sarah'});
const agentA=await rooms.createAgent(company.id,alex.user_id,"Alex's Agent");
const agentB=await rooms.createAgent(company.id,sarah.user_id,"Sarah's Agent");
await rooms.addMember({companyId:company.id,roomId:room.id,actorId:alex.principal_id,principalId:agentA.principal_id,role:'worker_agent',responsibilities:'Verify launch claims',idempotencyKey:'agent-a'});
await rooms.addMember({companyId:company.id,roomId:room.id,actorId:alex.principal_id,principalId:agentB.principal_id,role:'worker_agent',responsibilities:'Synthesize customer evidence',idempotencyKey:'agent-b'});
const createdTaskA=await rooms.createTask({companyId:company.id,roomId:room.id,actorId:alex.principal_id,title:'Verify launch claims',description:'Check every public claim against source material.',assigneePrincipalId:agentA.principal_id,idempotencyKey:'task-a'});
const createdTaskB=await rooms.createTask({companyId:company.id,roomId:room.id,actorId:alex.principal_id,title:'Synthesize customer evidence',description:'Turn interviews into a concise evidence note.',assigneePrincipalId:agentB.principal_id,idempotencyKey:'task-b'});
const taskA=await rooms.updateTaskStatus({companyId:company.id,roomId:room.id,actorId:alex.principal_id,taskId:createdTaskA.id,status:'in_progress',expectedVersion:createdTaskA.version,idempotencyKey:'start-a'});
const taskB=await rooms.updateTaskStatus({companyId:company.id,roomId:room.id,actorId:alex.principal_id,taskId:createdTaskB.id,status:'in_progress',expectedVersion:createdTaskB.version,idempotencyKey:'start-b'});
await rooms.sendMessage({companyId:company.id,roomId:room.id,actorId:alex.principal_id,body:'Use the verified evidence only. Surface any publication decision before acting.',idempotencyKey:'opening'});
const agentAScript:FakeScript=[{kind:'tool',id:'handoff',name:'room.send_message',arguments:{addressed_principal_id:agentB.principal_id,body:'Source review complete: retention and setup-time claims are verified. Use citations A12 and B07.'}},{kind:'tool',id:'done-task',name:'task.update_status',arguments:{task_id:taskA.id,status:'completed',expected_version:taskA.version}},{kind:'complete',id:'done'}];
const agentBScript:FakeScript=[{kind:'tool',id:'authority',name:'decision.request',arguments:{title:'Authorize launch note',question:'May I publish the verified launch note to the shared release workspace?',rationale:'The evidence is complete, but publication requires human authority.',proposed_action:{type:'publish',target:'release-workspace/atlas-launch',sources:['A12','B07']}}},{kind:'expect_decision',id:'approved',status:'approved',note_includes:'Proceed'},{kind:'tool',id:'resume-message',name:'room.send_message',arguments:{body:'Approval received. I am applying the instruction and preparing the release note now.'}},{kind:'complete',id:'done'}];
const runA=await runtime.queueRun({companyId:company.id,roomId:room.id,actorId:alex.principal_id,agentPrincipalId:agentA.principal_id,taskId:taskA.id,script:agentAScript,maxAttempts:3,idempotencyKey:'run-a'});
const runB=await runtime.queueRun({companyId:company.id,roomId:room.id,actorId:alex.principal_id,agentPrincipalId:agentB.principal_id,taskId:taskB.id,script:agentBScript,maxAttempts:3,idempotencyKey:'run-b'});
const worker=(id:string)=>new AgentWorker(runtime,new DeterministicFakeProvider(),{workerId:id,leaseMs:10_000});
class CapturingDelivery implements SignInLinkDelivery {
 readonly delivered:SignInLink[]=[];
 async deliver(link:SignInLink){this.delivered.push(link)}
}
const delivery=new CapturingDelivery();
const app=buildApp(pool,{pollIntervalMs:20},{allowHeaderPrincipal:false,cookieSecure:false,signInDelivery:delivery});
const fixture={companyId:company.id,roomId:room.id,alexId:alex.principal_id,sarahId:sarah.principal_id,agentAId:agentA.principal_id,agentBId:agentB.principal_id,taskAId:taskA.id,taskBId:taskB.id,runAId:runA.id,runBId:runB.id};
app.get('/__e2e/fixture',async()=>fixture);
// Test-only mail sink. Authentication itself still uses the public link and session routes.
app.get('/__e2e/auth-token',async req=>{
 const email=String((req.query as {email?:string}).email??'');
 const link=delivery.delivered.filter(item=>item.email===email).at(-1);
 return link?{token:link.token}:{token:null};
});
app.post('/__e2e/agent-a',async()=>({result:await worker('e2e-a').runOnce()}));
app.post('/__e2e/agent-b',async()=>({result:await worker('e2e-b').runOnce()}));
app.delete('/__e2e/sarah-access',async()=>rooms.removeMember({companyId:company.id,roomId:room.id,actorId:alex.principal_id,principalId:sarah.principal_id,idempotencyKey:'revoke-sarah'}));
const address=await app.listen({host:'127.0.0.1',port:4310});
console.log(`Slice 6 UI fixture listening at ${address}`);
const close=async()=>{await app.close();process.exit(0)};
process.once('SIGINT',close);process.once('SIGTERM',close);
