import { beforeAll, afterAll, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import { buildApp } from "../apps/api/src/app.js";
import { truncateAll } from "./support/database.js";
const {Pool}=pg;
const connectionString=process.env.DATABASE_URL??'postgres://postgres:postgres@127.0.0.1:55432/multiplayer_ai';
const pool=new Pool({connectionString});
const app=buildApp(pool,{},{allowHeaderPrincipal:true});
async function reset(){await truncateAll(pool)}
async function post(url:string,payload:unknown,headers:Record<string,string>={}): Promise<any> {return await app.inject({method:'POST',url,payload:payload as any,headers})}
async function setup(){
 const company=(await post('/v1/companies',{name:'Acme'})).json();
 const alex=(await post(`/v1/companies/${company.id}/humans`,{email:`alex-${crypto.randomUUID()}@example.com`,display_name:'Alex'})).json();
 const sarah=(await post(`/v1/companies/${company.id}/humans`,{email:`sarah-${crypto.randomUUID()}@example.com`,display_name:'Sarah'})).json();
 const alexAgent=(await post(`/v1/companies/${company.id}/agents`,{name:"Alex's Agent"},{'x-principal-id':alex.principal_id})).json();
 const project=(await post(`/v1/companies/${company.id}/projects`,{name:'Launch',objective:'Ship the multiplayer room'},{'x-principal-id':alex.principal_id})).json();
 const room=(await post(`/v1/companies/${company.id}/projects/${project.id}/rooms`,{name:'Launch Room',responsibilities:'Manage delivery'},{'x-principal-id':alex.principal_id})).json();
 await post(`/v1/companies/${company.id}/rooms/${room.id}/members`,{principal_id:sarah.principal_id,role:'contributor',responsibilities:'Product research'},{'x-principal-id':alex.principal_id,'idempotency-key':'member-sarah'});
 await post(`/v1/companies/${company.id}/rooms/${room.id}/members`,{principal_id:alexAgent.principal_id,role:'worker_agent',responsibilities:'Backend implementation'},{'x-principal-id':alex.principal_id,'idempotency-key':'member-agent'});
 return {company,alex,sarah,alexAgent,project,room};
}
beforeAll(async()=>{await reset();await app.ready()});
beforeEach(reset);
afterAll(async()=>{await app.close()});

describe('Phase 1A vertical slice',()=>{
 it('keeps conversation first-class and agent-addressed communication manager-auditable',async()=>{const s=await setup(); const first=await post(`/v1/companies/${s.company.id}/rooms/${s.room.id}/messages`,{body:'Can you send the implementation summary?',addressed_principal_id:s.alexAgent.principal_id},{'x-principal-id':s.sarah.principal_id,'idempotency-key':'message-1'}); expect(first.statusCode).toBe(200); const snap=await app.inject({method:'GET',url:`/v1/companies/${s.company.id}/rooms/${s.room.id}/snapshot`,headers:{'x-principal-id':s.alex.principal_id}}); expect(snap.statusCode).toBe(200); expect(snap.json().messages[0].body_text).toContain('implementation summary'); expect(snap.json().messages[0].task_id).toBeNull(); expect(snap.json().briefing.project_objective).toBe('Ship the multiplayer room'); expect(snap.json().briefing.joining_principal.role).toBe('manager');});
 it('makes duplicate commands idempotent and events ordered',async()=>{const s=await setup(); const url=`/v1/companies/${s.company.id}/rooms/${s.room.id}/tasks`; const headers={'x-principal-id':s.alex.principal_id,'idempotency-key':'task-1'}; const a=await post(url,{title:'Build API',description:'First slice',assignee_principal_id:s.alexAgent.principal_id},headers); const b=await post(url,{title:'Build API',description:'First slice',assignee_principal_id:s.alexAgent.principal_id},headers); expect(a.statusCode).toBe(200); expect(b.json().id).toBe(a.json().id); const events=await app.inject({method:'GET',url:`/v1/companies/${s.company.id}/rooms/${s.room.id}/events?after_seq=0`,headers:{'x-principal-id':s.alex.principal_id}}); const rows=events.json().events; expect(rows.map((e:any)=>e.room_seq)).toEqual(rows.map((_:any,i:number)=>i+1)); expect(rows.filter((e:any)=>e.event_type==='task.created')).toHaveLength(1);});
 it('allows exactly one truly concurrent task update at an expected version',async()=>{const s=await setup(); const made=await post(`/v1/companies/${s.company.id}/rooms/${s.room.id}/tasks`,{title:'Concurrent task',description:'',assignee_principal_id:s.alexAgent.principal_id},{'x-principal-id':s.alex.principal_id,'idempotency-key':'task-c'}); const task=made.json(); const url=`/v1/companies/${s.company.id}/rooms/${s.room.id}/tasks/${task.id}/status`; const [one,two]=await Promise.all([app.inject({method:'PATCH',url,payload:{status:'in_progress',expected_version:1},headers:{'x-principal-id':s.alexAgent.principal_id,'idempotency-key':'status-1'}}),app.inject({method:'PATCH',url,payload:{status:'cancelled',expected_version:1},headers:{'x-principal-id':s.alex.principal_id,'idempotency-key':'status-2'}})]); expect([one.statusCode,two.statusCode].sort()).toEqual([200,409]); const stale=[one,two].find(r=>r.statusCode===409)!;expect(stale.json().error.code).toBe('version_conflict');const persisted=await pool.query(`SELECT version FROM tasks WHERE id=$1`,[task.id]);expect(persisted.rows[0].version).toBe(2);});
 it('scopes idempotency receipts by room and command type',async()=>{const s=await setup();const room2=(await post(`/v1/companies/${s.company.id}/projects/${s.project.id}/rooms`,{name:'Second Room',responsibilities:'Manage second room'},{'x-principal-id':s.alex.principal_id})).json();const headers={'x-principal-id':s.alex.principal_id,'idempotency-key':'reused-scope-key'};const task1=await post(`/v1/companies/${s.company.id}/rooms/${s.room.id}/tasks`,{title:'First room task',description:''},headers);const task2=await post(`/v1/companies/${s.company.id}/rooms/${room2.id}/tasks`,{title:'Second room task',description:''},headers);const message=await post(`/v1/companies/${s.company.id}/rooms/${s.room.id}/messages`,{body:'Same key, different command'},headers);expect([task1.statusCode,task2.statusCode,message.statusCode]).toEqual([200,200,200]);expect(task2.json().id).not.toBe(task1.json().id);expect(message.json().id).not.toBe(task1.json().id);});
 it('enforces room isolation for snapshots and event replay',async()=>{const a=await setup(); const outsiderCompany=(await post('/v1/companies',{name:'Other'})).json(); const outsider=(await post(`/v1/companies/${outsiderCompany.id}/humans`,{email:`out-${crypto.randomUUID()}@example.com`,display_name:'Outsider'})).json(); const snap=await app.inject({method:'GET',url:`/v1/companies/${a.company.id}/rooms/${a.room.id}/snapshot`,headers:{'x-principal-id':outsider.principal_id}}); const events=await app.inject({method:'GET',url:`/v1/companies/${a.company.id}/rooms/${a.room.id}/events`,headers:{'x-principal-id':outsider.principal_id}}); expect(snap.statusCode).toBe(403); expect(events.statusCode).toBe(403);});

 it('records an explicit reply relationship and refuses one outside the room',async()=>{
  const s=await setup();
  const base=`/v1/companies/${s.company.id}/rooms/${s.room.id}/messages`;
  const first=(await post(base,{body:'Findings ready'},{'x-principal-id':s.alex.principal_id,'idempotency-key':'reply-first'})).json();
  const reply=await post(base,{body:'Reading them now',in_reply_to_message_id:first.id},{'x-principal-id':s.sarah.principal_id,'idempotency-key':'reply-second'});
  expect(reply.statusCode).toBe(200);
  expect(reply.json().in_reply_to_message_id).toBe(first.id);

  const stored=await pool.query(`SELECT in_reply_to_message_id FROM messages WHERE id=$1`,[reply.json().id]);
  expect(stored.rows[0].in_reply_to_message_id).toBe(first.id);
  const event=await pool.query(`SELECT payload FROM room_events WHERE entity_id=$1 AND event_type='message.sent'`,[reply.json().id]);
  expect(event.rows[0].payload.in_reply_to_message_id).toBe(first.id);

  // A reply must point at a message in this room, so the relationship can never cross rooms.
  const otherRoom=(await post(`/v1/companies/${s.company.id}/projects/${s.project.id}/rooms`,{name:'Other Room',responsibilities:'Elsewhere'},{'x-principal-id':s.alex.principal_id})).json();
  const foreign=(await post(`/v1/companies/${s.company.id}/rooms/${otherRoom.id}/messages`,{body:'Elsewhere'},{'x-principal-id':s.alex.principal_id,'idempotency-key':'reply-foreign'})).json();
  const rejected=await post(base,{body:'Nope',in_reply_to_message_id:foreign.id},{'x-principal-id':s.alex.principal_id,'idempotency-key':'reply-bad'});
  expect(rejected.statusCode).toBe(404);
  expect(rejected.json().error.code).toBe('message_not_found');

  const plain=(await post(base,{body:'Unrelated'},{'x-principal-id':s.alex.principal_id,'idempotency-key':'reply-none'})).json();
  expect(plain.in_reply_to_message_id).toBeNull();
 });
});
