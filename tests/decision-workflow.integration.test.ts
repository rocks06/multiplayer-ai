import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as pg from 'pg';
import {readFile} from 'node:fs/promises';
import {RoomService} from '../apps/api/src/room-service.js';
import {buildApp} from '../apps/api/src/app.js';
import {AgentRuntimeService,type Decision} from '../apps/api/src/agent-runtime/runtime-service.js';
import {AgentWorker} from '../apps/worker/src/agent-worker.js';
import {DeterministicFakeProvider,type FakeScript} from '../packages/provider-fake/src/index.js';

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL??'postgres://postgres:***@127.0.0.1:55432/multiplayer_ai';
const pool=new Pool({connectionString});
const rooms=new RoomService(pool);
const runtime=new AgentRuntimeService(pool,rooms);
const reset=()=>pool.query(`TRUNCATE decisions,agent_tool_calls,agent_runs,command_receipts,room_events,messages,tasks,room_members,rooms,projects,principals,agents,company_users,users,companies CASCADE`);

async function fixture(){
 const company=await rooms.createCompany(`Decision-${crypto.randomUUID()}`);
 const manager=await rooms.createHuman(company.id,`manager-${crypto.randomUUID()}@example.com`,'Manager');
 const other=await rooms.createHuman(company.id,`other-${crypto.randomUUID()}@example.com`,'Other Human');
 const backup=await rooms.createHuman(company.id,`backup-${crypto.randomUUID()}@example.com`,'Backup Manager');
 const project=await rooms.createProject(company.id,manager.principal_id,'Decision Project','Human authority boundary');
 const room=await rooms.createRoom(company.id,project.id,manager.principal_id,'Decision Room','Approve exact actions');
 await rooms.addMember({companyId:company.id,roomId:room.id,actorId:manager.principal_id,principalId:other.principal_id,role:'contributor',responsibilities:'Observe',idempotencyKey:'other'});
 await rooms.addMember({companyId:company.id,roomId:room.id,actorId:manager.principal_id,principalId:backup.principal_id,role:'manager',responsibilities:'Approve',idempotencyKey:'backup'});
 const agentA=await rooms.createAgent(company.id,manager.user_id,"Alex's Agent — AI");
 const agentB=await rooms.createAgent(company.id,manager.user_id,"Sarah's Agent — AI");
 for(const [agent,key] of [[agentA,'a'],[agentB,'b']] as const)await rooms.addMember({companyId:company.id,roomId:room.id,actorId:manager.principal_id,principalId:agent.principal_id,role:'worker_agent',responsibilities:`Agent ${key}`,idempotencyKey:`agent-${key}`});
 const taskA=await rooms.createTask({companyId:company.id,roomId:room.id,actorId:manager.principal_id,title:'A',description:'A',assigneePrincipalId:agentA.principal_id,idempotencyKey:'task-a'});
 const taskB=await rooms.createTask({companyId:company.id,roomId:room.id,actorId:manager.principal_id,title:'B',description:'B',assigneePrincipalId:agentB.principal_id,idempotencyKey:'task-b'});
 return {company,manager,other,backup,project,room,agentA,agentB,taskA,taskB};
}
const request=(id='approval'):Extract<FakeScript[number],{kind:'tool'}>=>({kind:'tool',id,name:'decision.request',arguments:{title:'Approve exact publish',question:'May I publish?',rationale:'Human authority required',proposed_action:{type:'publish',target:'release-42',body:'exact-v1'}}});
const script=(status:'approved'|'rejected',suffix:string):FakeScript=>[request(),{kind:'expect_decision',id:'observe',status,note_includes:status==='approved'?'ship':'stop'},{kind:'tool',id:'continue',name:'room.send_message',arguments:{body:`continued-${suffix}`}},{kind:'complete',id:'done'}];
const queue=(s:any,agent:any,task:any,steps:FakeScript,key:string)=>runtime.queueRun({companyId:s.company.id,roomId:s.room.id,actorId:s.manager.principal_id,agentPrincipalId:agent.principal_id,taskId:task.id,script:steps,maxAttempts:3,idempotencyKey:key});
const worker=(id:string)=>new AgentWorker(runtime,new DeterministicFakeProvider(),{workerId:id,leaseMs:10_000});
const decisionFor=async(runId:string)=>(await pool.query<Decision>(`SELECT * FROM decisions WHERE run_id=$1`,[runId])).rows[0]!;
const resolve=(s:any,d:Decision,status:'approved'|'rejected',key:string,note:string,actor=s.manager.principal_id)=>runtime.resolveDecision({companyId:s.company.id,roomId:s.room.id,actorId:actor,decisionId:d.id,resolution:status,proposedActionDigest:d.proposed_action_digest,expectedVersion:d.version,note,idempotencyKey:key});

beforeAll(async()=>{await pool.query(await readFile('packages/db/schema.sql','utf8'))});
beforeEach(reset);
afterAll(()=>pool.end());

describe('Vertical Slice 4 human decision and approval workflow',()=>{
 it('waits atomically, fences the old worker, approves with exact digest, resumes once, and preserves attribution/context',async()=>{
  const s=await fixture();const run=await queue(s,s.agentA,s.taskA,script('approved','approved'),'approval-run');
  const lease=await runtime.claimNext('requester',10_000);expect(lease?.id).toBe(run.id);
  const requested:any=await runtime.executeTool(lease!,request());expect(requested.waiting_for_decision).toBe(true);const replayed:any=await runtime.requestDecision(lease!,request());expect(replayed.id).toBe(requested.id);const changed=request();changed.arguments.proposed_action={type:'publish',target:'release-42',body:'changed-v2'};await expect(runtime.requestDecision(lease!,changed)).rejects.toMatchObject({code:'idempotency_key_reused'});
  expect((await runtime.getRun(run.id)).status).toBe('waiting_for_decision');
  const d=await decisionFor(run.id);expect(d).toMatchObject({status:'pending',version:1,requested_by_principal_id:s.agentA.principal_id});
  await expect(runtime.executeTool(lease!,{kind:'tool',id:'forbidden',name:'room.send_message',arguments:{body:'must-not-write'}})).rejects.toMatchObject({code:'stale_agent_run'});
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='must-not-write'`)).rows[0].n).toBe(0);
  await expect(resolve(s,d,'approved','unauthorized','ship',s.other.principal_id)).rejects.toMatchObject({statusCode:403});
  await expect(runtime.resolveDecision({companyId:s.company.id,roomId:s.room.id,actorId:s.agentA.principal_id,decisionId:d.id,resolution:'approved',proposedActionDigest:d.proposed_action_digest,expectedVersion:1,note:'ship',idempotencyKey:'agent-approve'})).rejects.toMatchObject({statusCode:403});
  await expect(runtime.resolveDecision({companyId:s.company.id,roomId:s.room.id,actorId:s.manager.principal_id,decisionId:d.id,resolution:'approved',proposedActionDigest:'0'.repeat(64),expectedVersion:1,note:'ship',idempotencyKey:'stale-action'})).rejects.toMatchObject({code:'stale_decision_action'});
  const approved=await resolve(s,d,'approved','approve-once','ship exactly');
  const duplicate=await resolve(s,d,'approved','approve-once','ship exactly');expect(duplicate).toEqual(approved);
  await expect(resolve(s,{...d,version:2},'rejected','conflict','stop')).rejects.toMatchObject({code:'decision_already_resolved'});
  const context:any=await runtime.contextForRun(run.id);expect(context.decision).toMatchObject({status:'approved',resolution_note:'ship exactly'});expect(context.room_changes_since_pause.some((e:any)=>e.event_type==='decision.approved')).toBe(true);
  expect(await worker('replacement-after-restart').runOnce()).toBe('completed');expect(await worker('extra-worker').runOnce()).toBe('idle');
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='continued-approved'`)).rows[0].n).toBe(1);
  const events=(await rooms.events(s.company.id,s.room.id,s.manager.principal_id,0,500)).events;
  const requestedEvent=events.find((e:any)=>e.event_type==='decision.requested');const approvedEvent=events.find((e:any)=>e.event_type==='decision.approved');
  expect(requestedEvent).toMatchObject({actor_principal_id:s.agentA.principal_id,actor_kind:'agent'});expect(approvedEvent).toMatchObject({actor_principal_id:s.manager.principal_id,actor_kind:'human'});
  expect(events.filter((e:any)=>e.event_type==='agent.run_resumed'&&e.entity_id===run.id)).toHaveLength(1);
 });

 it('delivers rejection and instruction to the resumed agent',async()=>{
  const s=await fixture();const run=await queue(s,s.agentA,s.taskA,script('rejected','rejected'),'reject-run');expect(await worker('request').runOnce()).toBe('waiting_for_decision');
  const d=await decisionFor(run.id);await resolve(s,d,'rejected','reject','stop and explain');expect(await worker('resume').runOnce()).toBe('completed');
  expect((await decisionFor(run.id)).status).toBe('rejected');expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='continued-rejected'`)).rows[0].n).toBe(1);
 });

 it('cancels pending decisions when the waiting run is cancelled or the agent is paused',async()=>{
  const s=await fixture();const runA=await queue(s,s.agentA,s.taskA,[request()], 'cancel-wait');await worker('wa').runOnce();
  await runtime.cancelRun({companyId:s.company.id,roomId:s.room.id,actorId:s.manager.principal_id,runId:runA.id,idempotencyKey:'cancel-run'});expect((await decisionFor(runA.id)).status).toBe('cancelled');
  const runB=await queue(s,s.agentB,s.taskB,[request()], 'pause-wait');await worker('wb').runOnce();await runtime.pauseAgent({companyId:s.company.id,roomId:s.room.id,actorId:s.manager.principal_id,agentId:s.agentB.agent_id,idempotencyKey:'pause-agent'});
  expect((await runtime.getRun(runB.id)).status).toBe('cancelled');expect((await decisionFor(runB.id)).status).toBe('cancelled');
  const count=(await pool.query(`SELECT count(*)::int n FROM room_events WHERE event_type='decision.cancelled'`)).rows[0].n;expect(count).toBe(2);
 });

 it('cancels safely when agent room authority is removed and rejects a manager after permission loss',async()=>{
  const s=await fixture();const run=await queue(s,s.agentA,s.taskA,[request()],'removed-agent');await worker('request').runOnce();const d=await decisionFor(run.id);
  await pool.query(`UPDATE room_members SET status='removed' WHERE company_id=$1 AND room_id=$2 AND principal_id=$3`,[s.company.id,s.room.id,s.agentA.principal_id]);await runtime.reconcileInvalidRuns();
  expect((await runtime.getRun(run.id)).status).toBe('cancelled');expect((await decisionFor(run.id)).status).toBe('cancelled');
  await pool.query(`UPDATE room_members SET role='contributor' WHERE company_id=$1 AND room_id=$2 AND principal_id=$3`,[s.company.id,s.room.id,s.manager.principal_id]);
  await expect(runtime.resolveDecision({companyId:s.company.id,roomId:s.room.id,actorId:s.manager.principal_id,decisionId:d.id,resolution:'approved',proposedActionDigest:d.proposed_action_digest,expectedVersion:d.version,note:'ship',idempotencyKey:'lost-permission'})).rejects.toMatchObject({statusCode:403});
 });

 it('keeps two agents waiting independently and enforces room scope',async()=>{
  const s=await fixture();const a=await queue(s,s.agentA,s.taskA,[request('a'),{kind:'complete',id:'done-a'}],'two-a');const b=await queue(s,s.agentB,s.taskB,[request('b'),{kind:'complete',id:'done-b'}],'two-b');
  expect(await worker('one').runOnce()).toBe('waiting_for_decision');expect(await worker('two').runOnce()).toBe('waiting_for_decision');const da=await decisionFor(a.id),db=await decisionFor(b.id);expect(da.id).not.toBe(db.id);
  const otherRoom=await rooms.createRoom(s.company.id,s.project.id,s.manager.principal_id,'Other Room','Isolation');await expect(runtime.getDecision({companyId:s.company.id,roomId:otherRoom.id,actorId:s.manager.principal_id,decisionId:da.id})).rejects.toMatchObject({code:'decision_not_found'});
  await resolve(s,da,'approved','a-ok','ship');await resolve(s,db,'rejected','b-no','stop');expect(await worker('resume-a').runOnce()).toBe('completed');expect(await worker('resume-b').runOnce()).toBe('completed');
 });
 it('expires overdue pending decisions and records the terminal audit event',async()=>{
  const expiring=request();expiring.arguments.expires_at=new Date(Date.now()-1000).toISOString();const s=await fixture();const run=await queue(s,s.agentA,s.taskA,[expiring],'expiry');await worker('wait').runOnce();const d=await decisionFor(run.id);expect(d.expires_at).not.toBeNull();expect(await runtime.expireDecisions()).toBe(1);expect((await decisionFor(run.id)).status).toBe('expired');expect((await runtime.getRun(run.id)).status).toBe('cancelled');expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE entity_id=$1 AND event_type='decision.expired'`,[d.id])).rows[0].n).toBe(1);
 });
 it('exposes scoped list/read and returns HTTP 403 for unauthorized approval',async()=>{
  const s=await fixture();const run=await queue(s,s.agentA,s.taskA,[request()],'http-decision');await worker('request').runOnce();const d=await decisionFor(run.id);const apiPool=new pg.Pool({connectionString});const app=buildApp(apiPool,{pollIntervalMs:50},{allowHeaderPrincipal:true});await app.ready();
  try{const base=`/v1/companies/${s.company.id}/rooms/${s.room.id}/decisions`;const headers={'x-principal-id':s.other.principal_id,'idempotency-key':'forbidden'};expect((await app.inject({method:'GET',url:base,headers})).statusCode).toBe(200);expect((await app.inject({method:'GET',url:`${base}/${d.id}`,headers})).statusCode).toBe(200);const denied=await app.inject({method:'POST',url:`${base}/${d.id}/approve`,headers,payload:{proposed_action_digest:d.proposed_action_digest,expected_version:1,note:'ship'}});expect(denied.statusCode,denied.body).toBe(403)}finally{await app.close()}
 });
});
