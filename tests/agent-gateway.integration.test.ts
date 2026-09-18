import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import {afterEach,beforeEach,describe,expect,it} from "vitest";
import * as pg from "pg";
import {readFile} from "node:fs/promises";
import {buildApp} from "../apps/api/src/app.js";
import {FakeExternalAgentClient} from "./fake-external-agent.js";
import type {RealtimeOptions} from "../apps/api/src/realtime/realtime-hub.js";
import { truncateAll } from "./support/database.js";
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error("DATABASE_URL is required for agent gateway integration tests");
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Wait for a condition the server reaches on its own, rather than guessing how long it takes. */
async function until(condition:()=>Promise<boolean>,timeoutMs=2000){
 const deadline=Date.now()+timeoutMs;
 while(Date.now()<deadline){if(await condition())return;await sleep(10);}
 throw new Error("condition was still false after "+timeoutMs+"ms");
}

describe("Agent Gateway v1",()=>{
 let pool:pg.Pool,app:ReturnType<typeof buildApp>,baseUrl:string;
 const clients=new Set<FakeExternalAgentClient>();
 async function start(options:RealtimeOptions={}){pool=new Pool({connectionString});app=buildApp(pool,{pollIntervalMs:20,...options},{allowHeaderPrincipal:true});baseUrl=await app.listen({host:"127.0.0.1",port:0})}
 async function request(method:string,url:string,payload?:unknown,headers:Record<string,string>={}){return await app.inject({method:method as any,url,payload:payload as any,headers})}
 async function post(url:string,payload:unknown,headers:Record<string,string>={}){return request("POST",url,payload,headers)}
 async function companyFixture(name="Gateway Co"){
  const company=(await seedCompany(pool, ({name}).name));
  const owner=(await seedHuman(pool, company.id, ({email:`${crypto.randomUUID()}@example.com`,display_name:`${name} Owner`}).email, ({email:`${crypto.randomUUID()}@example.com`,display_name:`${name} Owner`}).display_name));
  const project=(await post(`/v1/companies/${company.id}/projects`,{name:"Project",objective:"Coordinate external agents"},{"x-principal-id":owner.principal_id})).json();
  const room=(await post(`/v1/companies/${company.id}/projects/${project.id}/rooms`,{name:"Gateway Room",responsibilities:"Ship work"},{"x-principal-id":owner.principal_id})).json();
  return {company,owner,project,room};
 }
 async function agent(f:any,name:string,key:string,join=true){
  const value=(await post(`/v1/companies/${f.company.id}/agents`,{name},{'x-principal-id':f.owner.principal_id})).json();
  if(join)await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/members`,{principal_id:value.principal_id,role:"worker_agent",responsibilities:`${name} work`},{"x-principal-id":f.owner.principal_id,"idempotency-key":`join-${key}`});
  const credential=(await post(`/v1/companies/${f.company.id}/agents/${value.principal_id}/gateway-credentials`,{label:`${name} runtime`},{"x-principal-id":f.owner.principal_id})).json();
  return {...value,credential};
 }
 async function external(a:any,roomId:string){const c=new FakeExternalAgentClient(baseUrl);clients.add(c);c.credentialToken=a.credential.credential_token;c.roomId=roomId;expect((await c.open()).status).toBe(200);return c}
 async function createTask(f:any,title:string,assignee:string,key:string){return (await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/tasks`,{title,description:"gateway task",assignee_principal_id:assignee},{"x-principal-id":f.owner.principal_id,"idempotency-key":key})).json()}

 beforeEach(async()=>{const bootstrap=new Pool({connectionString});await truncateAll(bootstrap);await bootstrap.end();await start()});
 afterEach(async()=>{for(const c of clients)c.close();clients.clear();await app.close()});

 /** The shipped helper, spoken to the way the app speaks to it, on a disposable HOME. */
 function helperProcess(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mpai-helper-'));
  // Hermes' own wording. A profile is stopped while `gateway-stopped` exists; `gateway start` starts
  // only the profile named by HERMES_HOME, and fails where `gateway-start-fails` exists.
  const command=path.join(root,'hermes-fixture');fs.writeFileSync(command,['#!/bin/sh','case "$1" in','--version) printf "Hermes v0.20.5\\n";;','status) printf "ready\\n";;',
   'gateway) case "$2" in',
   '  status) if [ -f "$HERMES_HOME/gateway-stopped" ]; then printf "✗ Gateway is not running\\n"; else printf "✓ Gateway is supervised by launchd (PID 4242)\\n"; fi;;',
   '  start) printf "start\\n" >> "$HERMES_HOME/gateway-starts"; if [ -f "$HERMES_HOME/gateway-start-fails" ]; then printf "launchctl bootstrap failed: 5: Input/output error\\n" >&2; exit 1; fi; rm -f "$HERMES_HOME/gateway-stopped"; printf "Service started\\n";;',
   '  *) exit 1;; esac;;','chat) exit 0;;','*) exit 1;;','esac',''].join('\n'),{mode:0o700});
  const hermesHome=path.join(root,'hermes-home');fs.mkdirSync(hermesHome,{recursive:true});
  const child=spawn(process.env.MPAI_TEST_SIDECAR!,[],{env:{...process.env,HOME:root,HERMES_HOME:hermesHome,MPAI_IDENTITY_DIR:path.join(root,'identity'),MPAI_SUPPORT_DIR:path.join(root,'support'),HERMES_COMMAND:command},stdio:['pipe','pipe','pipe']});
  child.stderr.resume();const lines=readline.createInterface({input:child.stdout});let id=0;
  const pending=new Map<number,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:ReturnType<typeof setTimeout>}>();
  lines.on('line',line=>{const value=JSON.parse(line);const waiter=pending.get(value.id);if(waiter){clearTimeout(waiter.timer);pending.delete(value.id);value.ok?waiter.resolve(value):waiter.reject(Error(value.error))}});
  const call=(command:string,args:Record<string,unknown>={})=>new Promise<any>((resolve,reject)=>{const key=++id;const timer=setTimeout(()=>{pending.delete(key);reject(Error(`IPC timeout: ${command}`))},8000);pending.set(key,{resolve,reject,timer});child.stdin.write(JSON.stringify({id:key,command,...args})+'\n')});
  const close=async()=>{child.kill('SIGTERM');await new Promise<void>(resolve=>{if(child.exitCode!==null)resolve();else child.once('exit',()=>resolve())});lines.close();for(const waiter of pending.values())clearTimeout(waiter.timer);fs.rmSync(root,{recursive:true,force:true})};
  return {root,hermesHome,call,close};
 }
 const agentState=async(helper:ReturnType<typeof helperProcess>,principalId:string)=>((await helper.call('status')).state.agents??[]).find((a:any)=>a.agentPrincipalId===principalId);

 it.runIf(Boolean(process.env.MPAI_TEST_SIDECAR))("bundled helper moves A to B with the same credential and publishes A disconnect before B is live",async()=>{
  const f=await companyFixture(),a=await agent(f,'Move agent','move');
  const b=(await post(`/v1/companies/${f.company.id}/projects/${f.project.id}/rooms`,{name:'Room B'},{'x-principal-id':f.owner.principal_id})).json();
  await post(`/v1/companies/${f.company.id}/rooms/${b.id}/members`,{principal_id:a.principal_id,role:'worker_agent',responsibilities:''},{'x-principal-id':f.owner.principal_id,'idempotency-key':'join-move-b'});
  const observer=await external(await agent(f,'Observer','observer'),f.room.id);await observer.connect(0);
  const helper=helperProcess();const {call}=helper;
  try {
   await call('ping');const selected=(await call('detect')).runtimes[0];
   const config={baseUrl,roomId:f.room.id,agentPrincipalId:a.principal_id,credential:a.credential.credential_token,runtimeSelectionId:selected.runtimeInstallationId};
   await call('configure',config);await call('connect');await until(async()=>(await call('status')).state.gateway==='live',8000);
   const old=(await pool.query(`SELECT * FROM external_agent_sessions WHERE agent_principal_id=$1 AND status='connected'`,[a.principal_id])).rows[0];
   await call('disconnect');
   expect((await call('status')).state.gateway).not.toBe('live');
   expect((await pool.query(`SELECT status FROM external_agent_sessions WHERE id=$1`,[old.id])).rows[0].status).toBe('offline');
   await observer.waitFor(frame=>frame.type==='room.event'&&frame.event.event_type==='agent.session.disconnected'&&frame.event.payload.session_id===old.id);
   await call('configure',{...config,roomId:b.id});expect((await call('status')).state.gateway).not.toBe('live');
   await call('connect');await until(async()=>(await call('status')).state.gateway==='live',8000);
   const sessions=(await pool.query(`SELECT id,room_id,credential_id,status FROM external_agent_sessions WHERE agent_principal_id=$1`,[a.principal_id])).rows;
   expect(sessions.filter(row=>row.status==='connected')).toEqual([expect.objectContaining({room_id:b.id,credential_id:a.credential.id})]);
   expect(sessions.find(row=>row.id===old.id)?.status).toBe('superseded');
   expect((await pool.query(`SELECT count(*)::int n FROM external_agent_credentials WHERE agent_principal_id=$1`,[a.principal_id])).rows[0].n).toBe(1);
   await call('disconnect');
  } finally { await helper.close(); }
 });

 /**
  * Two agents on one Mac, the way the MacBook Air actually has them: one Hermes installation, two
  * profiles, each its own agent. Everything that happens to one must leave the other exactly as it was.
  */
 /**
  * Detect Agent found two stopped profiles and could connect neither. Selecting one now starts that
  * profile's gateway and nothing else's; a running one is left alone; a failure is reported with
  * Hermes' own words and can be retried. Profile names are fixtures.
  */
 it.runIf(Boolean(process.env.MPAI_TEST_SIDECAR))("bundled helper starts each stopped profile on its own, reports a failed start, then connects both",async()=>{
  const f=await companyFixture();
  const first=await agent(f,'Fixture One','one'),second=await agent(f,'Fixture Two','two');
  const helper=helperProcess();const {call}=helper;
  const named=path.join(helper.hermesHome,'profiles','fixture-named'),broken=path.join(helper.hermesHome,'profiles','fixture-broken');
  for(const home of [named,broken])fs.mkdirSync(home,{recursive:true});
  for(const home of [helper.hermesHome,named,broken])fs.writeFileSync(path.join(home,'gateway-stopped'),'');
  fs.writeFileSync(path.join(broken,'gateway-start-fails'),'');
  const starts=(home:string)=>fs.existsSync(path.join(home,'gateway-starts'))?fs.readFileSync(path.join(home,'gateway-starts'),'utf8').split('\n').filter(Boolean).length:0;
  try {
   await call('ping');
   const found=(await call('detect')).runtimes;
   expect(found.map((r:any)=>[r.profile,r.readiness])).toEqual([['default','installed_not_running'],['fixture-broken','installed_not_running'],['fixture-named','installed_not_running']]);
   const byProfile=(name:string)=>found.find((r:any)=>r.profile===name);
   // Default first: it starts, and nothing else is touched.
   const startedDefault=(await call('start-runtime',{runtimeInstallationId:byProfile('default').runtimeInstallationId})).runtime;
   expect(startedDefault.readiness).toBe('ready');
   expect([starts(helper.hermesHome),starts(named),starts(broken)]).toEqual([1,0,0]);
   expect(fs.existsSync(path.join(named,'gateway-stopped'))).toBe(true);
   // Then the named profile, on its own.
   const startedNamed=(await call('start-runtime',{runtimeInstallationId:byProfile('fixture-named').runtimeInstallationId})).runtime;
   expect(startedNamed.readiness).toBe('ready');
   expect([starts(helper.hermesHome),starts(named)]).toEqual([1,1]);
   // Already running: returned as ready, not started again.
   expect((await call('start-runtime',{runtimeInstallationId:byProfile('default').runtimeInstallationId})).runtime.readiness).toBe('ready');
   expect(starts(helper.hermesHome)).toBe(1);
   // A failure says what Hermes said, and the other two stay running.
   await expect(call('start-runtime',{runtimeInstallationId:byProfile('fixture-broken').runtimeInstallationId})).rejects.toThrow(/Input\/output error/);
   const after=(await call('detect')).runtimes;
   expect(after.map((r:any)=>[r.profile,r.readiness])).toEqual([['default','ready'],['fixture-broken','installed_not_running'],['fixture-named','ready']]);
   // And both started profiles connect, concurrently.
   const configure=async(a:any,runtime:any)=>{await call('configure',{baseUrl,roomId:f.room.id,agentPrincipalId:a.principal_id,credential:a.credential.credential_token,runtimeSelectionId:runtime.runtimeInstallationId});await call('connect',{runtimeSelectionId:runtime.runtimeInstallationId})};
   await configure(first,byProfile('default'));await configure(second,byProfile('fixture-named'));
   await until(async()=>(await agentState(helper,first.principal_id))?.gateway==='live'&&(await agentState(helper,second.principal_id))?.gateway==='live',8000);
  } finally { await helper.close(); }
 });

 it.runIf(Boolean(process.env.MPAI_TEST_SIDECAR))("bundled helper runs two Hermes profiles as two concurrent agents that move, disconnect and reconnect independently",async()=>{
  const f=await companyFixture();
  const jj=await agent(f,'JJ','jj'),axon=await agent(f,'AXON','axon');
  const b=(await post(`/v1/companies/${f.company.id}/projects/${f.project.id}/rooms`,{name:'Room B'},{'x-principal-id':f.owner.principal_id})).json();
  await post(`/v1/companies/${f.company.id}/rooms/${b.id}/members`,{principal_id:jj.principal_id,role:'worker_agent',responsibilities:''},{'x-principal-id':f.owner.principal_id,'idempotency-key':'join-jj-b'});
  const observerA=await external(await agent(f,'Observer','observer'),f.room.id);await observerA.connect(0);
  const helper=helperProcess();const {call}=helper;
  const credentials=async(principal:string)=>(await pool.query(`SELECT id,status FROM external_agent_credentials WHERE agent_principal_id=$1`,[principal])).rows;
  const live=async(principal:string)=>(await pool.query(`SELECT id,room_id,credential_id FROM external_agent_sessions WHERE agent_principal_id=$1 AND status='connected'`,[principal])).rows;
  // The default profile is named JJ; a second profile is named AXON; a deleted profile is not an agent.
  fs.writeFileSync(path.join(helper.hermesHome,'profile.yaml'),'display_name: JJ\n');
  fs.mkdirSync(path.join(helper.hermesHome,'profiles','axon'),{recursive:true});
  fs.writeFileSync(path.join(helper.hermesHome,'profiles','axon','profile.yaml'),"description: research\ndisplay_name: 'AXON'\n");
  fs.mkdirSync(path.join(helper.hermesHome,'profiles','old'),{recursive:true});
  fs.mkdirSync(path.join(helper.hermesHome,'profiles','.deleted','old'),{recursive:true});
  try {
   await call('ping');
   const runtimes=(await call('detect')).runtimes;
   expect(runtimes.map((r:any)=>[r.profile,r.displayName,r.readiness])).toEqual([['default','JJ','ready'],['axon','AXON','ready']]);
   const [jjRuntime,axonRuntime]=runtimes;
   expect(jjRuntime.runtimeInstallationId).not.toBe(axonRuntime.runtimeInstallationId);
   const jjConfig={baseUrl,roomId:f.room.id,agentPrincipalId:jj.principal_id,credential:jj.credential.credential_token,runtimeSelectionId:jjRuntime.runtimeInstallationId,agentDisplayName:'JJ'};
   const axonConfig={baseUrl,roomId:f.room.id,agentPrincipalId:axon.principal_id,credential:axon.credential.credential_token,runtimeSelectionId:axonRuntime.runtimeInstallationId,agentDisplayName:'AXON'};

   // Same room, both live at once.
   await call('configure',jjConfig);await call('connect',{runtimeSelectionId:jjRuntime.runtimeInstallationId});
   await call('configure',axonConfig);await call('connect',{runtimeSelectionId:axonRuntime.runtimeInstallationId});
   await until(async()=>(await agentState(helper,jj.principal_id))?.gateway==='live'&&(await agentState(helper,axon.principal_id))?.gateway==='live',8000);
   expect(await live(jj.principal_id)).toEqual([expect.objectContaining({room_id:f.room.id,credential_id:jj.credential.id})]);
   expect(await live(axon.principal_id)).toEqual([expect.objectContaining({room_id:f.room.id,credential_id:axon.credential.id})]);
   const axonSession=(await live(axon.principal_id))[0].id;

   // Move JJ A → B: A hears it left before B is live; AXON's session is untouched.
   const jjInA=(await live(jj.principal_id))[0].id;
   await call('disconnect',{agentPrincipalId:jj.principal_id});
   await observerA.waitFor(frame=>frame.type==='room.event'&&frame.event.event_type==='agent.session.disconnected'&&frame.event.payload.session_id===jjInA);
   expect(await live(jj.principal_id)).toEqual([]);
   await call('configure',{...jjConfig,roomId:b.id});
   await call('connect',{runtimeSelectionId:jjRuntime.runtimeInstallationId});
   await until(async()=>(await agentState(helper,jj.principal_id))?.gateway==='live',8000);
   // Different rooms, both live, same identities and credentials, nothing new minted.
   expect(await live(jj.principal_id)).toEqual([expect.objectContaining({room_id:b.id,credential_id:jj.credential.id})]);
   expect(await live(axon.principal_id)).toEqual([expect.objectContaining({id:axonSession,room_id:f.room.id})]);
   expect((await agentState(helper,axon.principal_id)).gateway).toBe('live');
   expect(await credentials(jj.principal_id)).toEqual([{id:jj.credential.id,status:'active'}]);
   expect(await credentials(axon.principal_id)).toEqual([{id:axon.credential.id,status:'active'}]);

   // Disconnect actually disconnects JJ, and only JJ; Reconnect needs nothing new.
   await call('disconnect',{agentPrincipalId:jj.principal_id});
   expect((await agentState(helper,jj.principal_id)).gateway).toBe('offline');
   expect(await live(jj.principal_id)).toEqual([]);
   expect((await agentState(helper,axon.principal_id)).gateway).toBe('live');
   await call('reconnect',{agentPrincipalId:jj.principal_id});
   await until(async()=>(await agentState(helper,jj.principal_id))?.gateway==='live',8000);
   expect(await live(jj.principal_id)).toEqual([expect.objectContaining({room_id:b.id,credential_id:jj.credential.id})]);

   // A person disconnects JJ from Room B in the room: it stops at once, is not asked to sign in,
   // keeps its credential, and connects again once it is back in the room.
   await request('DELETE',`/v1/companies/${f.company.id}/rooms/${b.id}/members/${jj.principal_id}`,undefined,{'x-principal-id':f.owner.principal_id,'idempotency-key':'disconnect-jj-b'});
   await until(async()=>(await agentState(helper,jj.principal_id))?.gateway==='removed',5000);
   expect((await agentState(helper,jj.principal_id)).running).toBe(false);
   expect((await agentState(helper,axon.principal_id)).gateway).toBe('live');
   expect(await credentials(jj.principal_id)).toEqual([{id:jj.credential.id,status:'active'}]);
   await sleep(1500);
   expect(await live(jj.principal_id)).toEqual([]);
   // Starting it again while it is still out of the room — as a relaunch does — stays Disconnected,
   // never "sign-in needed".
   await call('connect',{agentPrincipalId:jj.principal_id});
   await until(async()=>['removed','auth_required'].includes((await agentState(helper,jj.principal_id))?.gateway),8000);
   expect((await agentState(helper,jj.principal_id)).gateway).toBe('removed');
   await post(`/v1/companies/${f.company.id}/rooms/${b.id}/members`,{principal_id:jj.principal_id,role:'worker_agent',responsibilities:''},{'x-principal-id':f.owner.principal_id,'idempotency-key':'rejoin-jj-b'});
   await call('connect',{agentPrincipalId:jj.principal_id});
   await until(async()=>(await agentState(helper,jj.principal_id))?.gateway==='live',8000);
   expect(await live(jj.principal_id)).toEqual([expect.objectContaining({room_id:b.id,credential_id:jj.credential.id})]);
   expect(await live(axon.principal_id)).toEqual([expect.objectContaining({id:axonSession})]);
  } finally { await helper.close(); }
 });

 /* Remove from room: this room's membership ends, a live session here ends first and is told so,
    and nothing about the agent itself — identity, credential, other rooms — changes. */
 it("removing an agent from one room ends only that membership and keeps it available everywhere else",async()=>{
  const f=await companyFixture();const a=await agent(f,"Fixture Agent","remove-one");
  const other=(await post(`/v1/companies/${f.company.id}/projects/${f.project.id}/rooms`,{name:"Other Room"},{"x-principal-id":f.owner.principal_id})).json();
  const live=await external(a,f.room.id);await live.connect(0);
  const removed=await request("DELETE",`/v1/companies/${f.company.id}/rooms/${f.room.id}/members/${a.principal_id}`,undefined,{"x-principal-id":f.owner.principal_id,"idempotency-key":"remove-from-room"});
  expect(removed.statusCode).toBe(200);
  await live.waitFor(frame=>frame.type==="session_ended"&&frame.reason==="removed_from_room");
  expect((await pool.query(`SELECT count(*)::int n FROM external_agent_sessions WHERE agent_principal_id=$1 AND status='connected'`,[a.principal_id])).rows[0].n).toBe(0);
  expect((await pool.query(`SELECT status FROM room_members WHERE room_id=$1 AND principal_id=$2`,[f.room.id,a.principal_id])).rows[0].status).toBe("removed");
  expect((await pool.query(`SELECT status FROM principals WHERE id=$1`,[a.principal_id])).rows[0].status).toBe("active");
  expect((await pool.query(`SELECT status FROM external_agent_credentials WHERE id=$1`,[a.credential.id])).rows[0].status).toBe("active");
  const listed=(await request("GET",`/v1/companies/${f.company.id}/agents`,undefined,{"x-principal-id":f.owner.principal_id})).json().agents.find((x:any)=>x.principal_id===a.principal_id);
  expect(listed).toBeTruthy();
  expect(listed.rooms??[]).toEqual([]);
  const snapshot=(await request("GET",`/v1/companies/${f.company.id}/rooms/${f.room.id}/snapshot`,undefined,{"x-principal-id":f.owner.principal_id})).json();
  expect(snapshot.members.some((m:any)=>m.principal_id===a.principal_id)).toBe(false);
  // Available for another room, with the credential it already has.
  expect((await post(`/v1/companies/${f.company.id}/rooms/${other.id}/members`,{principal_id:a.principal_id,role:"worker_agent",responsibilities:""},{"x-principal-id":f.owner.principal_id,"idempotency-key":"add-to-other"})).statusCode).toBe(200);
  const elsewhere=new FakeExternalAgentClient(baseUrl);clients.add(elsewhere);
  expect((await elsewhere.open(a.credential.credential_token,other.id)).status).toBe(200);
 });

 it("authenticates scoped credentials and rejects revocation, impersonation by IDs, cross-agent/company access, and inactive membership",async()=>{
  const aCo=await companyFixture("A"),bCo=await companyFixture("B");const a=await agent(aCo,"Agent A","a"),b=await agent(aCo,"Agent B","b",false);await agent(bCo,"Agent C","c");
  const probe=new FakeExternalAgentClient(baseUrl);probe.credentialToken=a.credential.credential_token;
  const discovered=await probe.discover();expect(discovered.status).toBe(200);expect(discovered.body.agent_principal_id).toBe(a.principal_id);expect(discovered.body.rooms.map((r:any)=>r.id)).toEqual([aCo.room.id]);
  expect((await probe.open(a.credential.credential_token,bCo.room.id)).status).toBe(403);
  expect((await probe.open(b.credential.credential_token,aCo.room.id)).status).toBe(403);
  const live=await external(a,aCo.room.id);await live.connect(0);
  await request("DELETE",`/v1/companies/${aCo.company.id}/rooms/${aCo.room.id}/members/${a.principal_id}`,undefined,{"x-principal-id":aCo.owner.principal_id,"idempotency-key":"remove-a"});
  expect((await live.heartbeat("idle")).status).toBe(401);
  // Taken out of the room, told so at once — and not told its credential is dead, because it is not.
  await live.waitFor(f=>f.type==="session_ended"&&f.reason==="removed_from_room");
  expect((await pool.query(`SELECT status FROM external_agent_credentials WHERE id=$1`,[a.credential.id])).rows[0].status).toBe("active");
  expect((await probe.open(a.credential.credential_token,aCo.room.id)).status).toBe(403);
  await post(`/v1/companies/${aCo.company.id}/rooms/${aCo.room.id}/members`,{principal_id:a.principal_id,role:"worker_agent",responsibilities:""},{"x-principal-id":aCo.owner.principal_id,"idempotency-key":"readd-a"});
  expect((await probe.open(a.credential.credential_token,aCo.room.id)).status).toBe(200);
  const a2=await agent(aCo,"Agent A2","a2");const c2=await external(a2,aCo.room.id);await c2.connect(0);
  const guessed=await fetch(`${baseUrl}/v1/agent-gateway/v1/sessions/${crypto.randomUUID()}/heartbeat`,{method:"POST",headers:{authorization:`Bearer ${c2.sessionToken}`,"content-type":"application/json"},body:JSON.stringify({runtime_status:"idle"})});expect(guessed.status).toBe(401);
  const persisted=await pool.query(`SELECT c.token_hash,c.token_prefix,s.session_token_hash FROM external_agent_credentials c JOIN external_agent_sessions s ON s.credential_id=c.id WHERE c.id=$1 AND s.id=$2`,[a2.credential.id,c2.sessionId]);expect(persisted.rows[0].token_hash).not.toContain(a2.credential.credential_token);expect(persisted.rows[0].session_token_hash).not.toContain(c2.sessionToken);expect(persisted.rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);expect(persisted.rows[0].session_token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect((await post(`/v1/companies/${aCo.company.id}/rooms/${aCo.room.id}/agents/${a2.agent_id}/pause`,{}, {"x-principal-id":aCo.owner.principal_id,"idempotency-key":"pause-a2"})).statusCode).toBe(200);expect((await c2.heartbeat("idle")).status).toBe(401);await c2.waitFor(f=>f.type==="access_revoked");
  const a3=await agent(aCo,"Agent A3","a3");const c3=await external(a3,aCo.room.id);expect((await request("DELETE",`/v1/companies/${aCo.company.id}/gateway-credentials/${a3.credential.id}`,undefined,{"x-principal-id":aCo.owner.principal_id})).statusCode).toBe(200);expect((await c3.heartbeat("idle")).status).toBe(401);expect((await c3.open(a3.credential.credential_token,aCo.room.id)).status).toBe(401);
 });

 it("executes the narrow command surface with agent attribution and hosted/external authorization parity",async()=>{
  const f=await companyFixture(),a=await agent(f,"Alex AI","alex"),b=await agent(f,"Blair AI","blair");const ca=await external(a,f.room.id),cb=await external(b,f.room.id);await ca.connect(0);await cb.connect(0);
  const ta=await createTask(f,"A task",a.principal_id,"task-a"),tb=await createTask(f,"B task",b.principal_id,"task-b");
  expect((await ca.tasks()).body.map((t:any)=>t.id)).toContain(ta.id);expect((await ca.task(ta.id)).status).toBe(200);
  const own=await ca.updateTask(ta.id,"in_progress",1,"a-start");expect(own.status).toBe(200);
  const unauthorized=await ca.updateTask(tb.id,"in_progress",1,"steal-b");expect(unauthorized.status).toBe(403);
  const internal=await request("PATCH",`/v1/companies/${f.company.id}/rooms/${f.room.id}/tasks/${tb.id}/status`,{status:"in_progress",expected_version:1},{"x-principal-id":a.principal_id,"idempotency-key":"internal-steal"});expect(internal.statusCode).toBe(403);expect(internal.json().error.code).toBe(unauthorized.body.error.code);
  const roomMessage=await ca.message("Working now","external-message");expect(roomMessage.status).toBe(200);const addressed=await ca.message("Blair, please review","external-address",b.principal_id);expect(addressed.status).toBe(200);await cb.waitFor(f=>f.type==="room.event"&&f.event.entity_id===addressed.body.id);
  expect((await ca.completeTask(ta.id,2,"a-complete")).status).toBe(200);
  const events=await pool.query(`SELECT event_type,actor_principal_id,actor_kind FROM room_events WHERE company_id=$1 AND room_id=$2 AND entity_id=ANY($3::uuid[]) ORDER BY room_seq`,[f.company.id,f.room.id,[roomMessage.body.id,addressed.body.id,ta.id]]);
  expect(events.rows.filter(r=>r.event_type==="message.sent").every(r=>r.actor_principal_id===a.principal_id&&r.actor_kind==="agent")).toBe(true);
  expect(events.rows.some(r=>r.event_type==="task.completed"&&r.actor_principal_id===a.principal_id)).toBe(true);
 });

 it("requests and reads an external decision, then receives the human resolution through the durable room stream",async()=>{
  const f=await companyFixture(),a=await agent(f,"Decision AI","decision");const c=await external(a,f.room.id);await c.connect(0);
  const requested=await c.requestDecision({title:"Deploy?",question:"May I deploy?",rationale:"Checks passed",proposed_action:{operation:"deploy",environment:"staging"}},"decision-one");expect(requested.status).toBe(200);expect(requested.body.run_id).toBeNull();expect((await c.decision(requested.body.id)).body.status).toBe("pending");
  const resolved=await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/decisions/${requested.body.id}/approve`,{proposed_action_digest:requested.body.proposed_action_digest,expected_version:1,note:"Approved externally"},{"x-principal-id":f.owner.principal_id,"idempotency-key":"approve-external"});expect(resolved.statusCode).toBe(200);expect(resolved.json().run_status).toBeNull();
  const frame=await c.waitFor(f=>f.type==="room.event"&&f.event.event_type==="decision.approved");expect(frame.event.actor_principal_id).toBe(f.owner.principal_id);expect((await c.decision(requested.body.id)).body.status).toBe("approved");
  const requestedEvent=await pool.query(`SELECT actor_principal_id,actor_kind FROM room_events WHERE entity_id=$1 AND event_type='decision.requested'`,[requested.body.id]);expect(requestedEvent.rows[0]).toMatchObject({actor_principal_id:a.principal_id,actor_kind:"agent"});
 });

 it("replays a disconnect window without duplicates or gaps and keeps two external runtimes synchronized",async()=>{
  const f=await companyFixture(),a=await agent(f,"Agent A","sync-a"),b=await agent(f,"Agent B","sync-b");const ca=await external(a,f.room.id),cb=await external(b,f.room.id);await ca.connect(0);await cb.connect(0);
  const ta=await createTask(f,"Separate A",a.principal_id,"separate-a"),tb=await createTask(f,"Separate B",b.principal_id,"separate-b");await ca.waitFor(f=>f.type==="room.event"&&f.event.entity_id===tb.id);await cb.waitFor(f=>f.type==="room.event"&&f.event.entity_id===ta.id);
  const before=ca.tracker.contiguousSeq;ca.close();await sleep(75);
  await cb.message("missed one","missed-one");await cb.updateTask(tb.id,"in_progress",1,"b-start");await sleep(75);
  ca.frames.length=0;await ca.connect(before);await ca.waitFor(f=>f.type==="room.event"&&f.event.event_type==="task.in_progress");
  expect(ca.gaps).toEqual([]);expect([...ca.applied.keys()].filter(seq=>seq>before)).toEqual([...new Set([...ca.applied.keys()].filter(seq=>seq>before))]);
  const durable=await pool.query(`SELECT last_ack_room_seq FROM external_agent_sessions WHERE id=$1`,[ca.sessionId]);await sleep(50);expect(Number(durable.rows[0]?.last_ack_room_seq??0)).toBeLessThanOrEqual(ca.tracker.contiguousSeq);
  expect((await ca.heartbeat("working")).body.runtime_status).toBe("working");
 });

 it("enrolls a connector from a single-use code without exposing a raw credential to the human path",async()=>{
  const f=await companyFixture(),a=await agent(f,"Enroll AI","enroll");
  const issued=await post(`/v1/companies/${f.company.id}/agents/${a.principal_id}/enrollments`,{label:"Rocco MacBook"},{"x-principal-id":f.owner.principal_id});
  expect(issued.statusCode).toBe(200);
  const code=issued.json().enrollment_code as string;
  expect(code).toMatch(/^MPAI-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  expect(new Date(issued.json().expires_at).getTime()).toBeGreaterThan(Date.now());

  // Only a digest is retained; the typed code cannot be recovered from the row.
  const stored=await pool.query(`SELECT code_hash,code_prefix,status,credential_id FROM agent_enrollment_tokens WHERE company_id=$1`,[f.company.id]);
  expect(stored.rows[0].code_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(stored.rows[0].code_hash).not.toContain(code);
  expect(stored.rows[0].status).toBe("pending");

  const redeemed=await post("/v1/agent-gateway/v1/enroll",{code,device_label:"MacBook Air"});
  expect(redeemed.statusCode).toBe(200);
  // The principal comes from the token, never from the caller.
  expect(redeemed.json().agent_principal_id).toBe(a.principal_id);
  expect(redeemed.json().company_id).toBe(f.company.id);
  expect(redeemed.json().rooms.map((r:any)=>r.id)).toEqual([f.room.id]);
  const credential=redeemed.json().credential_token as string;

  const client=new FakeExternalAgentClient(baseUrl);clients.add(client);
  expect((await client.open(credential,f.room.id)).status).toBe(200);
  await client.connect(0);
  expect((await client.snapshot()).status).toBe(200);

  const consumed=await pool.query(`SELECT status,consumed_at,device_label,credential_id FROM agent_enrollment_tokens WHERE company_id=$1`,[f.company.id]);
  expect(consumed.rows[0].status).toBe("consumed");
  expect(consumed.rows[0].consumed_at).not.toBeNull();
  expect(consumed.rows[0].device_label).toBe("MacBook Air");
  expect(consumed.rows[0].credential_id).not.toBeNull();
  const persisted=await pool.query(`SELECT token_hash FROM external_agent_credentials WHERE id=$1`,[consumed.rows[0].credential_id]);
  expect(persisted.rows[0].token_hash).not.toContain(credential);
 });

 it("refuses replayed, unknown, expired, and unauthorized enrollment",async()=>{
  const f=await companyFixture(),a=await agent(f,"Enroll AI","enroll2");
  const issue=()=>post(`/v1/companies/${f.company.id}/agents/${a.principal_id}/enrollments`,{label:"Device"},{"x-principal-id":f.owner.principal_id});

  const first=(await issue()).json().enrollment_code as string;
  expect((await post("/v1/agent-gateway/v1/enroll",{code:first})).statusCode).toBe(200);
  // A consumed code can never be redeemed twice, however fast the second attempt arrives.
  expect((await post("/v1/agent-gateway/v1/enroll",{code:first})).statusCode).toBe(401);

  expect((await post("/v1/agent-gateway/v1/enroll",{code:"MPAI-AAAA-BBBB-CCCC"})).statusCode).toBe(401);

  const stale=(await issue()).json().enrollment_code as string;
  await pool.query(`UPDATE agent_enrollment_tokens SET expires_at=now()-interval '1 minute' WHERE code_prefix=$1 AND status='pending'`,[stale.slice(0,9)]);
  expect((await post("/v1/agent-gateway/v1/enroll",{code:stale})).statusCode).toBe(401);

  // An agent principal cannot mint enrollment for itself or anyone else.
  expect((await post(`/v1/companies/${f.company.id}/agents/${a.principal_id}/enrollments`,{label:"Self"},{"x-principal-id":a.principal_id})).statusCode).toBe(403);
 });

 it("does not consume a valid enrollment until a usable room binding can be returned, and redeems atomically once",async()=>{
  const f=await companyFixture("Atomic Enrollment");
  const unroomed=(await post(`/v1/companies/${f.company.id}/agents`,{name:"Agent A"},{"x-principal-id":f.owner.principal_id})).json();
  const issued=await post(`/v1/companies/${f.company.id}/agents/${unroomed.principal_id}/enrollments`,{label:"Agent A runtime"},{"x-principal-id":f.owner.principal_id});
  const code=issued.json().enrollment_code as string;

  const before=await pool.query(`SELECT count(*)::int count FROM external_agent_credentials WHERE company_id=$1 AND agent_principal_id=$2`,[f.company.id,unroomed.principal_id]);
  const refused=await post("/v1/agent-gateway/v1/enroll",{code,device_label:"Mac mini"});
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error.code).toBe("enrollment_room_required");
  const afterFailure=await pool.query(`SELECT status,consumed_at,credential_id FROM agent_enrollment_tokens WHERE code_prefix=$1`,[code.slice(0,9)]);
  expect(afterFailure.rows[0]).toEqual({status:"pending",consumed_at:null,credential_id:null});
  const credentialsAfterFailure=await pool.query(`SELECT count(*)::int count FROM external_agent_credentials WHERE company_id=$1 AND agent_principal_id=$2`,[f.company.id,unroomed.principal_id]);
  expect(credentialsAfterFailure.rows[0].count).toBe(before.rows[0].count);
  const sessionsAfterFailure=await pool.query(`SELECT count(*)::int count FROM external_agent_sessions WHERE company_id=$1 AND agent_principal_id=$2`,[f.company.id,unroomed.principal_id]);
  expect(sessionsAfterFailure.rows[0].count).toBe(0);

  await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/members`,{principal_id:unroomed.principal_id,role:"worker_agent",responsibilities:"Coordinate the release"},{"x-principal-id":f.owner.principal_id,"idempotency-key":"join-after-failed-enrollment"});

  // Competing requests exercise the row lock: exactly one receives the one usable credential.
  const attempts=await Promise.all([
    post("/v1/agent-gateway/v1/enroll",{code,device_label:"Mac mini A"}),
    post("/v1/agent-gateway/v1/enroll",{code,device_label:"Mac mini B"}),
  ]);
  expect(attempts.map(result=>result.statusCode).sort()).toEqual([200,401]);
  const success=attempts.find(result=>result.statusCode===200)!;
  expect(success.json().rooms.map((room:any)=>room.id)).toEqual([f.room.id]);
  expect(typeof success.json().credential_token).toBe("string");
  expect((await post("/v1/agent-gateway/v1/enroll",{code})).statusCode).toBe(401);

  const finalToken=await pool.query(`SELECT status,consumed_at,credential_id FROM agent_enrollment_tokens WHERE code_prefix=$1`,[code.slice(0,9)]);
  expect(finalToken.rows[0].status).toBe("consumed");
  expect(finalToken.rows[0].consumed_at).not.toBeNull();
  expect(finalToken.rows[0].credential_id).not.toBeNull();
  const finalCredentials=await pool.query(`SELECT count(*)::int count FROM external_agent_credentials WHERE company_id=$1 AND agent_principal_id=$2`,[f.company.id,unroomed.principal_id]);
  expect(finalCredentials.rows[0].count).toBe(before.rows[0].count+1);
 });

 it("reports durable session status read-only, including after disconnect, without touching liveness",async()=>{
  const f=await companyFixture(),a=await agent(f,"Status AI","status"),b=await agent(f,"Other AI","other");
  const c=await external(a,f.room.id);await c.connect(0);
  await createTask(f,"Status task",a.principal_id,"status-task");
  await c.waitFor(frame=>frame.type==="room.event");
  const connected=await c.sessionStatus();
  expect(connected.status).toBe(200);
  expect(connected.body.status).toBe("connected");
  expect(connected.body.agent_principal_id).toBe(a.principal_id);
  expect(connected.body.room_id).toBe(f.room.id);
  expect(connected.body.room_last_event_seq).toBeGreaterThan(0);
  expect(Number.isInteger(connected.body.last_ack_room_seq)).toBe(true);

  // An offline session must report as offline rather than 401, so a restarted runtime can tell
  // "the Gateway forgot me" apart from "I am simply not connected".
  c.close();await sleep(150);
  const offline=await c.sessionStatus();
  expect(offline.status).toBe(200);
  expect(offline.body.status).toBe("offline");

  // A status probe must not refresh liveness. An absent runtime has to keep looking absent,
  // otherwise the check that would have caught the room sequence 21 outage lies too.
  const before=(await pool.query(`SELECT last_seen_at FROM external_agent_sessions WHERE id=$1`,[c.sessionId])).rows[0].last_seen_at;
  await sleep(40);
  expect((await c.sessionStatus()).body.status).toBe("offline");
  const after=(await pool.query(`SELECT last_seen_at FROM external_agent_sessions WHERE id=$1`,[c.sessionId])).rows[0].last_seen_at;
  expect(new Date(after).getTime()).toBe(new Date(before).getTime());

  const other=await external(b,f.room.id);
  const stolen=await fetch(`${baseUrl}/v1/agent-gateway/v1/sessions/${c.sessionId}`,{headers:{authorization:`Bearer ${other.sessionToken}`}});
  expect(stolen.status).toBe(401);
 });

 it("lets one agent reply explicitly to another agent's message",async()=>{
  const f=await companyFixture(),a=await agent(f,"Agent A","agentA"),b=await agent(f,"Agent B","agentB");
  const agentA=await external(a,f.room.id),agentB=await external(b,f.room.id);
  const findings=await agentA.message("Findings: the constraint is in the authorization boundary.","agentA-findings",b.principal_id);
  expect(findings.status).toBe(200);

  // Agent-to-agent coordination is a stated relationship, not adjacency in the transcript.
  const reply=await agentB.message("Agreed. Testing option two against the Gateway.","agentB-reply",a.principal_id,findings.body.id);
  expect(reply.status).toBe(200);
  expect(reply.body.in_reply_to_message_id).toBe(findings.body.id);

  const stored=await pool.query(`SELECT sender_principal_id,in_reply_to_message_id FROM messages WHERE id=$1`,[reply.body.id]);
  expect(stored.rows[0]).toEqual({sender_principal_id:b.principal_id,in_reply_to_message_id:findings.body.id});

  const snapshot=await agentB.snapshot();
  expect(snapshot.body.messages.at(-1).in_reply_to_message_id).toBe(findings.body.id);
 });

 it("reports agent presence in the room snapshot from durable session state",async()=>{
  const f=await companyFixture(),a=await agent(f,"Presence AI","presence");
  const members=async()=>{
   const snap=await request("GET",`/v1/companies/${f.company.id}/rooms/${f.room.id}/snapshot`,undefined,{"x-principal-id":f.owner.principal_id});
   return snap.json().members as any[];
  };
  const mine=async()=>(await members()).find(m=>m.principal_id===a.principal_id);

  // Never connected is distinct from offline: nothing has ever run for this principal.
  expect((await mine()).agent_presence).toBe("never");
  expect((await members()).find(m=>m.principal_id===f.owner.principal_id).agent_presence).toBeNull();

  const c=await external(a,f.room.id);await c.connect(0);
  expect((await mine()).agent_presence).toBe("connected");
  expect((await mine()).agent_runtime_status).toBe("idle");

  expect((await c.heartbeat("working")).status).toBe(200);
  expect((await mine()).agent_runtime_status).toBe("working");

  /* Waking is itself a room event, and the client acks it — which touches last_seen_at. Backdate
     before that ack lands and the ack undoes it, so the session reads connected again and this
     assertion fails only when the machine is busy. Wait for the ack to be durable first: nothing
     else is coming, so after it there is no writer left to race with. */
  await c.waitFor(frame=>frame.type==="room.event"&&frame.event.event_type==="agent.woke");
  await until(async()=>Number((await pool.query(`SELECT last_ack_room_seq FROM external_agent_sessions WHERE id=$1`,[c.sessionId])).rows[0].last_ack_room_seq)>=c.tracker.contiguousSeq);

  // A session the Gateway still calls connected but which stopped reporting must not read
  // as live — this is the state that made a vanished connector look healthy.
  /* The socket is still open, and every realtime poll re-validates it — which is itself evidence
     of life and touches last_seen_at. A poll landing between the backdate and the read is a real
     writer, not a bug; the claim is that an old last_seen reads stale, so backdate until the read
     observes it rather than hoping no poll arrives in between. */
  await until(async()=>{
    await pool.query(`UPDATE external_agent_sessions SET last_seen_at=now()-interval '2 minutes' WHERE id=$1`,[c.sessionId]);
    return (await mine()).agent_presence==="stale";
  });

  await pool.query(`UPDATE external_agent_sessions SET status='offline',disconnected_at=now() WHERE id=$1`,[c.sessionId]);
  expect((await mine()).agent_presence).toBe("offline");
  c.close();
 });

 /**
  * Being replaced must not be reported as being shut out.
  *
  * Both used to send `access_revoked`, which the runtime treats as terminal and the supervisor
  * classified by searching the message for "revoked". So a Mac that had just re-bound itself told
  * its owner that its access had been removed and asked for a new enrollment code — while the room
  * went on showing the agent connected. One frame, two entirely different situations.
  */
 it("tells a replaced session it was replaced, not that its access was revoked",async()=>{
  const f=await companyFixture(),a=await agent(f,"JJ","jj");
  const first=await external(a,f.room.id);await first.connect(0);
  // The same agent comes back on a newer connection, which is what a rebind looks like.
  const second=await external(a,f.room.id);await second.connect(0);

  const frame=await first.waitFor(frame=>frame.type==="session_superseded"||frame.type==="access_revoked");
  expect(frame.type).toBe("session_superseded");
  expect(frame.reason).toBe("superseded");
  // And the newer one is untouched.
  expect((await second.heartbeat("working")).status).toBe(200);
 });

 it("forces stale and slow clients to resynchronize instead of dropping or reordering events",async()=>{
  await app.close();await start({maxReplayEvents:1,maxUnackedEvents:1,pollIntervalMs:15});const f=await companyFixture(),a=await agent(f,"Slow AI","slow");const c=await external(a,f.room.id);
  await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/messages`,{body:"one"},{"x-principal-id":f.owner.principal_id,"idempotency-key":"pre-one"});await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/messages`,{body:"two"},{"x-principal-id":f.owner.principal_id,"idempotency-key":"pre-two"});
  await c.connect(0);expect((await c.waitFor(f=>f.type==="resync_required")).reason).toBe("stale_cursor");
  const fresh=await external(a,f.room.id);await fresh.connect(undefined,false,true);await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/messages`,{body:"three"},{"x-principal-id":f.owner.principal_id,"idempotency-key":"slow-three"});await post(`/v1/companies/${f.company.id}/rooms/${f.room.id}/messages`,{body:"four"},{"x-principal-id":f.owner.principal_id,"idempotency-key":"slow-four"});expect((await fresh.waitFor(f=>f.type==="resync_required")).reason).toBe("slow_client");
 });
});
