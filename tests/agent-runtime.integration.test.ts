import {afterAll,beforeAll,beforeEach,describe,expect,it} from 'vitest';
import * as pg from 'pg';
import {readFile} from 'node:fs/promises';
import {RoomService} from '../apps/api/src/room-service.js';
import {buildApp} from '../apps/api/src/app.js';
import {AgentRuntimeService} from '../apps/api/src/agent-runtime/runtime-service.js';
import {AgentWorker,SimulatedWorkerCrash} from '../apps/worker/src/agent-worker.js';
import {DeterministicFakeProvider,FakeBarrierController,type FakeScript} from '../packages/provider-fake/src/index.js';

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL??'postgres://postgres:***@127.0.0.1:55432/multiplayer_ai';
const pool=new Pool({connectionString});
const roomService=new RoomService(pool);
const runtime=new AgentRuntimeService(pool,roomService);

async function reset(){await pool.query(`TRUNCATE agent_tool_calls,agent_runs,command_receipts,room_events,messages,tasks,room_members,rooms,projects,principals,agents,company_users,users,companies CASCADE`)}
async function fixture(){
 const company=await roomService.createCompany(`Runtime-${crypto.randomUUID()}`);
 const alex=await roomService.createHuman(company.id,`alex-${crypto.randomUUID()}@example.com`,'Alex');
 const project=await roomService.createProject(company.id,alex.principal_id,'Runtime Project','Prove independently executing agents');
 const room=await roomService.createRoom(company.id,project.id,alex.principal_id,'Runtime Room','Manage agents');
 const agentA=await roomService.createAgent(company.id,alex.user_id,"Alex's Agent — AI");
 const agentB=await roomService.createAgent(company.id,alex.user_id,"Sarah's Agent — AI");
 await roomService.addMember({companyId:company.id,roomId:room.id,actorId:alex.principal_id,principalId:agentA.principal_id,role:'worker_agent',responsibilities:'Task A',idempotencyKey:'member-a'});
 await roomService.addMember({companyId:company.id,roomId:room.id,actorId:alex.principal_id,principalId:agentB.principal_id,role:'worker_agent',responsibilities:'Task B',idempotencyKey:'member-b'});
 const taskA=await roomService.createTask({companyId:company.id,roomId:room.id,actorId:alex.principal_id,title:'Task A',description:'Agent A work',assigneePrincipalId:agentA.principal_id,idempotencyKey:'task-a'});
 const taskB=await roomService.createTask({companyId:company.id,roomId:room.id,actorId:alex.principal_id,title:'Task B',description:'Agent B work',assigneePrincipalId:agentB.principal_id,idempotencyKey:'task-b'});
 return {company,alex,project,room,agentA,agentB,taskA,taskB};
}
const queue=(s:any,agent:any,task:any,script:FakeScript,key:string,maxAttempts=3)=>runtime.queueRun({companyId:s.company.id,roomId:s.room.id,actorId:s.alex.principal_id,agentPrincipalId:agent.principal_id,taskId:task.id,script,maxAttempts,idempotencyKey:key});
const expire=async(runId:string)=>{await pool.query(`UPDATE agent_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1`,[runId])};
const row=async(id:string)=>runtime.getRun(id);
const worker=(name:string,barriers=new FakeBarrierController(),hooks:any={})=>new AgentWorker(runtime,new DeterministicFakeProvider(barriers),{workerId:name,leaseMs:100,hooks});
const start=(taskId:string):FakeScript[number]=>({kind:'tool',id:'start',name:'task.update_status',arguments:{task_id:taskId,status:'in_progress',expected_version:1}});
const complete=(taskId:string):FakeScript[number]=>({kind:'tool',id:'complete',name:'task.complete',arguments:{task_id:taskId,expected_version:2}});
const message=(id:string,body:string,addressed?:string):FakeScript[number]=>({kind:'tool',id,name:'room.send_message',arguments:{body,addressed_principal_id:addressed}});

beforeAll(async()=>{await pool.query(await readFile('packages/db/schema.sql','utf8'))});
beforeEach(reset);
afterAll(async()=>pool.end());

describe('Vertical Slice 3 durable agent runtime',()=>{
 it('allows two different agents in one room to overlap, communicate, and retain agent attribution',async()=>{
  const s=await fixture(); const barriers=new FakeBarrierController();
  const a=await queue(s,s.agentA,s.taskA,[start(s.taskA.id),message('ask-b','Agent B, please respond',s.agentB.principal_id),{kind:'barrier',id:'hold-a',name:'a'},complete(s.taskA.id),{kind:'complete',id:'done-a'}],'run-a');
  const b=await queue(s,s.agentB,s.taskB,[start(s.taskB.id),{kind:'expect_message',id:'observe-a',includes:'please respond',sender_principal_id:s.agentA.principal_id},message('reply-a','Agent B responding',s.agentA.principal_id),complete(s.taskB.id),{kind:'complete',id:'done-b'}],'run-b');
  const wa=worker('worker-a',barriers); const pa=wa.runOnce(); await barriers.waitUntilBlocked('a');
  expect((await row(a.id)).status).toBe('running');
  await worker('worker-b',barriers).runOnce();
  expect((await row(b.id)).status).toBe('completed'); expect((await row(a.id)).status).toBe('running');
  barriers.release('a'); await pa;
  expect((await row(a.id)).status).toBe('completed');
  const events=await roomService.events(s.company.id,s.room.id,s.alex.principal_id,0,500);
  const agentEvents=events.events.filter((e:any)=>['message.sent','task.in_progress','task.completed'].includes(e.event_type));
  expect(agentEvents.some((e:any)=>e.actor_principal_id===s.agentA.principal_id&&e.actor_kind==='agent'&&e.actor_display_name==="Alex's Agent — AI")).toBe(true);
  expect(agentEvents.some((e:any)=>e.actor_principal_id===s.agentB.principal_id&&e.actor_kind==='agent'&&e.actor_display_name==="Sarah's Agent — AI")).toBe(true);
  expect(agentEvents.every((e:any)=>e.actor_principal_id!==s.alex.principal_id)).toBe(true);
 });

 it('enforces the scheduler-only one-active-run constraint per agent and room',async()=>{
  const s=await fixture(); await queue(s,s.agentA,s.taskA,[{kind:'complete',id:'done'}],'first');
  await expect(queue(s,s.agentA,s.taskA,[{kind:'complete',id:'done'}],'second')).rejects.toMatchObject({code:'agent_run_active'});
  await expect(queue(s,s.agentB,s.taskB,[{kind:'complete',id:'done'}],'different-agent')).resolves.toBeTruthy();
 });

 it('recovers when a worker dies before a tool command',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[message('once','before-tool recovery'),{kind:'complete',id:'done'}],'crash-before'); let once=true;
  await expect(worker('crasher',new FakeBarrierController(),{beforeTool:()=>{if(once){once=false;throw new SimulatedWorkerCrash('before_tool')}}}).runOnce()).rejects.toBeInstanceOf(SimulatedWorkerCrash);
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='before-tool recovery'`)).rows[0].n).toBe(0);
  await expire(run.id); await worker('replacement').runOnce();
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='before-tool recovery'`)).rows[0].n).toBe(1);
 });

 it('replays a committed tool idempotently after a crash before checkpoint',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[message('once','after-tool recovery'),{kind:'complete',id:'done'}],'crash-after'); let once=true;
  await expect(worker('crasher',new FakeBarrierController(),{afterTool:()=>{if(once){once=false;throw new SimulatedWorkerCrash('after_tool')}}}).runOnce()).rejects.toBeInstanceOf(SimulatedWorkerCrash);
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='after-tool recovery'`)).rows[0].n).toBe(1);
  expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE event_type='message.sent' AND payload->>'body_text'='after-tool recovery'`)).rows[0].n).toBe(1);
  await expire(run.id); await worker('replacement').runOnce();
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='after-tool recovery'`)).rows[0].n).toBe(1);
  expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE event_type='message.sent' AND payload->>'body_text'='after-tool recovery'`)).rows[0].n).toBe(1);
  expect((await pool.query(`SELECT count(*)::int n FROM command_receipts WHERE idempotency_key=$1`,[`agent-run:${run.id}:g${run.run_generation}:once`])).rows[0].n).toBe(1);
  expect((await pool.query(`SELECT count(*)::int n FROM agent_tool_calls WHERE run_id=$1 AND provider_call_id='once'`,[run.id])).rows[0].n).toBe(1);
  expect((await row(run.id)).status).toBe('completed');
 });

 it('reuses a committed task completion after a crash without a second transition or event',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[start(s.taskA.id),complete(s.taskA.id),{kind:'complete',id:'done'}],'crash-after-task'); let toolCount=0;
  await expect(worker('crasher',new FakeBarrierController(),{afterTool:()=>{toolCount++;if(toolCount===2)throw new SimulatedWorkerCrash('after_task_complete')}}).runOnce()).rejects.toBeInstanceOf(SimulatedWorkerCrash);
  expect((await pool.query(`SELECT status,version FROM tasks WHERE id=$1`,[s.taskA.id])).rows[0]).toMatchObject({status:'completed',version:3});
  expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE event_type='task.completed' AND entity_id=$1`,[s.taskA.id])).rows[0].n).toBe(1);
  await expire(run.id); expect(await worker('replacement').runOnce()).toBe('completed');
  expect((await pool.query(`SELECT status,version FROM tasks WHERE id=$1`,[s.taskA.id])).rows[0]).toMatchObject({status:'completed',version:3});
  expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE event_type='task.completed' AND entity_id=$1`,[s.taskA.id])).rows[0].n).toBe(1);
  expect((await pool.query(`SELECT count(*)::int n FROM command_receipts WHERE idempotency_key=$1`,[`agent-run:${run.id}:g${run.run_generation}:complete`])).rows[0].n).toBe(1);
 });

 it('rejects lease renewal and terminal writes from an expired worker',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[{kind:'complete',id:'done'}],'expired-worker');
  const lease=await runtime.claimNext('expired-worker',10_000); expect(lease?.id).toBe(run.id); await expire(run.id);
  expect(await runtime.renewLease(lease!,10_000)).toBe(false);
  expect(await runtime.completeRun(lease!)).toBe('cancelled');
  expect(await runtime.failRun(lease!,{code:'stale',message:'must not publish'})).toBe('cancelled');
  expect((await row(run.id)).status).toBe('running');
  expect(await worker('replacement').runOnce()).toBe('completed');
 });

 it('retries transient provider failure within the bound and fails permanent provider errors',async()=>{
  const s=await fixture(); const transient=await queue(s,s.agentA,s.taskA,[message('before-retry','committed before retry'),{kind:'transient_failure',id:'flaky',times:2},{kind:'complete',id:'done'}],'transient',3);
  expect(await worker('w1').runOnce()).toBe('retry_scheduled'); expect(await worker('w2').runOnce()).toBe('retry_scheduled'); expect(await worker('w3').runOnce()).toBe('completed');
  expect((await row(transient.id)).attempt_count).toBe(3);
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='committed before retry'`)).rows[0].n).toBe(1);
  expect((await pool.query(`SELECT count(*)::int n FROM room_events WHERE event_type='message.sent' AND payload->>'body_text'='committed before retry'`)).rows[0].n).toBe(1);
  const permanent=await queue(s,s.agentB,s.taskB,[{kind:'permanent_failure',id:'bad',message:'invalid response'}],'permanent',3);
  expect(await worker('w4').runOnce()).toBe('failed'); expect((await row(permanent.id)).status).toBe('failed');
 });

 it('cancels an agent paused while queued before provider execution',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[message('forbidden','must not send')],'pause-queued');
  await runtime.pauseAgent({companyId:s.company.id,roomId:s.room.id,actorId:s.alex.principal_id,agentId:s.agentA.agent_id,idempotencyKey:'pause-a'});
  expect(await worker('worker').runOnce()).toBe('idle'); expect((await row(run.id)).status).toBe('cancelled');
  expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='must not send'`)).rows[0].n).toBe(0);
 });

 it('fences a paused agent while running before its next mutation',async()=>{
  const s=await fixture(); const barriers=new FakeBarrierController(); const run=await queue(s,s.agentA,s.taskA,[{kind:'barrier',id:'hold',name:'pause'},message('blocked','must not commit'),{kind:'complete',id:'done'}],'pause-running');
  const pending=worker('worker',barriers).runOnce(); await barriers.waitUntilBlocked('pause');
  await runtime.pauseAgent({companyId:s.company.id,roomId:s.room.id,actorId:s.alex.principal_id,agentId:s.agentA.agent_id,idempotencyKey:'pause-running-command'}); barriers.release('pause'); await pending;
  expect((await row(run.id)).status).toBe('cancelled'); expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='must not commit'`)).rows[0].n).toBe(0);
 });

 it('fences a running agent whose room membership is removed',async()=>{
  const s=await fixture(); const barriers=new FakeBarrierController(); const run=await queue(s,s.agentA,s.taskA,[{kind:'barrier',id:'hold',name:'remove'},message('blocked','membership lost'),{kind:'complete',id:'done'}],'membership-running');
  const pending=worker('worker',barriers).runOnce(); await barriers.waitUntilBlocked('remove');
  await roomService.removeMember({companyId:s.company.id,roomId:s.room.id,actorId:s.alex.principal_id,principalId:s.agentA.principal_id,idempotencyKey:'remove-running-agent'}); barriers.release('remove'); await pending;
  expect((await row(run.id)).status).toBe('cancelled'); expect((await pool.query(`SELECT count(*)::int n FROM messages WHERE body_text='membership lost'`)).rows[0].n).toBe(0);
 });

 it('rejects a stale worker after cancellation changes the generation',async()=>{
  const s=await fixture(); const barriers=new FakeBarrierController(); const run=await queue(s,s.agentA,s.taskA,[{kind:'barrier',id:'hold',name:'cancel'},complete(s.taskA.id)],'cancel-running');
  const pending=worker('stale-worker',barriers).runOnce(); await barriers.waitUntilBlocked('cancel'); const before=(await row(run.id)).run_generation;
  await runtime.cancelRun({companyId:s.company.id,roomId:s.room.id,actorId:s.alex.principal_id,runId:run.id,idempotencyKey:'cancel'}); barriers.release('cancel'); await pending;
  expect((await row(run.id)).run_generation).toBeGreaterThan(before); expect((await row(run.id)).status).toBe('cancelled');
  expect((await pool.query(`SELECT status FROM tasks WHERE id=$1`,[s.taskA.id])).rows[0].status).toBe('open');
 });

 it('rejects unauthorized tools against another agents task',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[{kind:'tool',id:'steal',name:'task.update_status',arguments:{task_id:s.taskB.id,status:'in_progress',expected_version:1}}],'unauthorized');
  expect(await worker('worker').runOnce()).toBe('failed'); expect((await row(run.id)).error_code).toBe('permission_denied');
  expect((await pool.query(`SELECT status FROM tasks WHERE id=$1`,[s.taskB.id])).rows[0].status).toBe('open');
 });

 it('assembles context only from the authorized company and room',async()=>{
  const s=await fixture(); const other=await fixture(); await roomService.sendMessage({companyId:other.company.id,roomId:other.room.id,actorId:other.alex.principal_id,body:'TOP SECRET OTHER ROOM',idempotencyKey:'secret'});
  const run=await queue(s,s.agentA,s.taskA,[{kind:'complete',id:'done'}],'context'); const context=await runtime.contextForRun(run.id);
  expect(JSON.stringify(context)).not.toContain('TOP SECRET OTHER ROOM'); expect(context.company_id).toBe(s.company.id); expect(context.room.id).toBe(s.room.id); expect(context.agent.principal_id).toBe(s.agentA.principal_id);
 });

 it('restarted worker resumes from the last completed checkpoint',async()=>{
  const s=await fixture(); const run=await queue(s,s.agentA,s.taskA,[message('first','checkpoint one'),message('second','checkpoint two'),{kind:'complete',id:'done'}],'checkpoint'); let toolCount=0;
  await expect(worker('first',new FakeBarrierController(),{beforeTool:()=>{toolCount++;if(toolCount===2)throw new SimulatedWorkerCrash('restart')}}).runOnce()).rejects.toBeInstanceOf(SimulatedWorkerCrash);
  expect((await row(run.id)).checkpoint_step).toBe(1); await expire(run.id); await worker('restarted').runOnce();
  const bodies=(await pool.query(`SELECT body_text FROM messages WHERE body_text LIKE 'checkpoint %' ORDER BY body_text`)).rows.map((x:any)=>x.body_text);
  expect(bodies).toEqual(['checkpoint one','checkpoint two']); expect((await row(run.id)).status).toBe('completed');
 });

 it('secures and idempotently controls runs through HTTP',async()=>{
  const s=await fixture();const apiPool=new pg.Pool({connectionString});const app=buildApp(apiPool,{pollIntervalMs:50},{allowHeaderPrincipal:true});await app.ready();
  try{
   const path=`/v1/companies/${s.company.id}/rooms/${s.room.id}/agent-runs`;const payload={agent_principal_id:s.agentA.principal_id,task_id:s.taskA.id,script:[{kind:'complete',id:'done'}],max_attempts:3};
   expect((await app.inject({method:'POST',url:path,headers:{'idempotency-key':'http-run'},payload})).statusCode).toBe(401);
   expect((await app.inject({method:'POST',url:path,headers:{'x-principal-id':s.agentA.principal_id,'idempotency-key':'http-run-agent'},payload})).statusCode).toBe(403);
   const first=await app.inject({method:'POST',url:path,headers:{'x-principal-id':s.alex.principal_id,'idempotency-key':'http-run'},payload});expect(first.statusCode,first.body).toBe(200);const run=first.json();
   const replay=await app.inject({method:'POST',url:path,headers:{'x-principal-id':s.alex.principal_id,'idempotency-key':'http-run'},payload});expect(replay.json().id).toBe(run.id);
   expect((await app.inject({method:'GET',url:`${path}/${run.id}`,headers:{'x-principal-id':s.agentA.principal_id}})).statusCode).toBe(200);
   const cancelled=await app.inject({method:'POST',url:`${path}/${run.id}/cancel`,headers:{'x-principal-id':s.alex.principal_id,'idempotency-key':'http-cancel'}});expect(cancelled.statusCode,cancelled.body).toBe(200);expect(cancelled.json().status).toBe('cancelled');
  } finally {await app.close()}
 });
});
