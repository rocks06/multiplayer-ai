import {afterEach,beforeEach,describe,expect,it} from 'vitest';
import * as pg from 'pg';
import {buildApp} from '../apps/api/src/app.js';
import {truncateAll} from './support/database.js';
import { seedCompany, seedHuman } from "./support/bootstrap.js";

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL;
if(!connectionString)throw new Error('DATABASE_URL is required for project objective tests');
const UNSET='Objective pending room creation';

describe('Project objective mutation',()=>{
 let pool:pg.Pool,app:ReturnType<typeof buildApp>;
 const call=(method:string,url:string,payload?:unknown,headers:Record<string,string>={})=>app.inject({method:method as any,url,payload:payload as any,headers});
 const asActor=(principalId:string,key=crypto.randomUUID())=>({'x-principal-id':principalId,'idempotency-key':key});
 async function fixture(){
  const company=(await seedCompany(pool, ({name:'Objective Co'}).name));
  const owner=(await seedHuman(pool, company.id, ({email:`owner-${crypto.randomUUID()}@example.com`,display_name:'Owner'}).email, ({email:`owner-${crypto.randomUUID()}@example.com`,display_name:'Owner'}).display_name));
  const member=(await seedHuman(pool, company.id, ({email:`member-${crypto.randomUUID()}@example.com`,display_name:'Member'}).email, ({email:`member-${crypto.randomUUID()}@example.com`,display_name:'Member'}).display_name));
  const project=(await call('POST',`/v1/companies/${company.id}/projects`,{name:'P',objective:UNSET},{'x-principal-id':owner.principal_id})).json();
  const room=(await call('POST',`/v1/companies/${company.id}/projects/${project.id}/rooms`,{name:'R',responsibilities:'Own it'},{'x-principal-id':owner.principal_id})).json();
  await call('POST',`/v1/companies/${company.id}/rooms/${room.id}/members`,{principal_id:member.principal_id,role:'contributor',responsibilities:'Contribute'},asActor(owner.principal_id));
  return {company,owner,member,project,room,path:`/v1/companies/${company.id}/projects/${project.id}/objective`};
 }
 beforeEach(async()=>{const bootstrap=new Pool({connectionString});await truncateAll(bootstrap);await bootstrap.end();pool=new Pool({connectionString});app=buildApp(pool,{pollIntervalMs:50},{allowHeaderPrincipal:true})});
 afterEach(async()=>{await app.close()});

 it('refuses unauthenticated requests',async()=>{
  const f=await fixture();
  const response=await call('PATCH',f.path,{objective:'Ship it',expected_objective:UNSET});
  expect(response.statusCode).toBe(401);
 });

 it('refuses a company member without active room-manager authority',async()=>{
  const f=await fixture();
  const response=await call('PATCH',f.path,{objective:'Ship it',expected_objective:UNSET},asActor(f.member.principal_id));
  expect(response.statusCode,response.body).toBe(403);
  expect((await pool.query('SELECT objective FROM projects WHERE id=$1',[f.project.id])).rows[0].objective).toBe(UNSET);
 });

 it('allows an authorized human manager and makes exact retries idempotent',async()=>{
  const f=await fixture();
  const payload={objective:'Ship it',expected_objective:UNSET};
  const first=await call('PATCH',f.path,payload,asActor(f.owner.principal_id));
  expect(first.statusCode,first.body).toBe(200);
  expect(first.json().objective).toBe('Ship it');
  const replay=await call('PATCH',f.path,payload,asActor(f.owner.principal_id));
  expect(replay.statusCode,replay.body).toBe(200);
  expect(replay.json().objective).toBe('Ship it');
 });

 it('refuses a stale conflicting write using neighboring version-conflict semantics',async()=>{
  const f=await fixture();
  expect((await call('PATCH',f.path,{objective:'First',expected_objective:UNSET},asActor(f.owner.principal_id))).statusCode).toBe(200);
  const stale=await call('PATCH',f.path,{objective:'Second',expected_objective:UNSET},asActor(f.owner.principal_id));
  expect(stale.statusCode,stale.body).toBe(409);
  expect(stale.json().error.code).toBe('version_conflict');
  expect(stale.json().error.details).toEqual({expected_objective:UNSET,current_objective:'First'});
  expect((await pool.query('SELECT objective FROM projects WHERE id=$1',[f.project.id])).rows[0].objective).toBe('First');
 });

 it('cannot update a project through another company or another company principal',async()=>{
  const f=await fixture();
  const otherCompany=(await seedCompany(pool, ({name:'Other Co'}).name));
  const outsider=(await seedHuman(pool, otherCompany.id, ({email:`outsider-${crypto.randomUUID()}@example.com`,display_name:'Outsider'}).email, ({email:`outsider-${crypto.randomUUID()}@example.com`,display_name:'Outsider'}).display_name));
  const wrongCompanyPath=`/v1/companies/${otherCompany.id}/projects/${f.project.id}/objective`;
  expect((await call('PATCH',wrongCompanyPath,{objective:'Hijack',expected_objective:UNSET},asActor(outsider.principal_id))).statusCode).toBe(404);
  expect((await call('PATCH',f.path,{objective:'Hijack',expected_objective:UNSET},asActor(outsider.principal_id))).statusCode).toBe(403);
  expect((await pool.query('SELECT objective FROM projects WHERE id=$1',[f.project.id])).rows[0].objective).toBe(UNSET);
 });
});
