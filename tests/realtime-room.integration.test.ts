import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as pg from "pg";
import WebSocket from "ws";
import { readFile } from "node:fs/promises";
import { buildApp } from "../apps/api/src/app.js";
import { SequenceTracker } from "../apps/api/src/realtime/protocol.js";
import type { RealtimeOptions } from "../apps/api/src/realtime/realtime-hub.js";

const {Pool}=pg;
const connectionString=process.env.DATABASE_URL??"postgres://postgres:postgres@127.0.0.1:55432/multiplayer_ai";
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

class LiveClient {
  readonly frames:any[]=[];
  readonly applied=new Map<number,any>();
  readonly gaps:number[]=[];
  readonly socket:WebSocket;
  tracker?:SequenceTracker;

  constructor(url:string,principalId?:string,private readonly autoAck=true) {
    this.socket=new WebSocket(url,principalId?{headers:{"x-principal-id":principalId}}:undefined);
    this.socket.on("message",raw=>{
      const frame=JSON.parse(raw.toString());
      this.frames.push(frame);
      if(frame.type==="snapshot") this.tracker=new SequenceTracker(frame.snapshot_seq);
      if(frame.type==="resumed") this.tracker=new SequenceTracker(frame.after_seq);
      if(frame.type==="event") {
        const result=this.tracker!.observe(frame.event.room_seq);
        if(result==="gap") this.gaps.push(frame.event.room_seq);
        if(result==="next") {
          this.applied.set(frame.event.room_seq,frame.event);
          if(this.autoAck) this.socket.send(JSON.stringify({type:"ack",room_seq:this.tracker!.contiguousSeq}));
        }
      }
    });
  }

  get lastSeq(){return this.tracker?.contiguousSeq??0}
  async waitFor(predicate:(frame:any)=>boolean,timeout=3000) {
    const started=Date.now();
    while(Date.now()-started<timeout) {
      const found=this.frames.find(predicate);
      if(found) return found;
      await sleep(10);
    }
    throw new Error(`Timed out waiting for frame. Received: ${JSON.stringify(this.frames)}`);
  }
  close(){if(this.socket.readyState===WebSocket.OPEN||this.socket.readyState===WebSocket.CONNECTING)this.socket.close()}
}

describe("Phase 1A realtime room synchronization",()=>{
  let pool:pg.Pool;
  let app:ReturnType<typeof buildApp>;
  let baseUrl:string;
  const clients=new Set<LiveClient>();

  async function start(options:RealtimeOptions={}) {
    pool=new Pool({connectionString});
    app=buildApp(pool,{pollIntervalMs:25,...options});
    const address=await app.listen({host:"127.0.0.1",port:0});
    baseUrl=address;
  }

  async function restart(options:RealtimeOptions={}) {
    for(const client of clients) client.close();
    clients.clear();
    await app.close();
    await start(options);
  }

  async function post(url:string,payload:unknown,headers:Record<string,string>={}) {
    return app.inject({method:"POST",url,payload:payload as any,headers});
  }

  async function setup() {
    const company=(await post("/v1/companies",{name:"Realtime Co"})).json();
    const alex=(await post(`/v1/companies/${company.id}/humans`,{email:`alex-${crypto.randomUUID()}@example.com`,display_name:"Alex"})).json();
    const sarah=(await post(`/v1/companies/${company.id}/humans`,{email:`sarah-${crypto.randomUUID()}@example.com`,display_name:"Sarah"})).json();
    const project=(await post(`/v1/companies/${company.id}/projects`,{name:"Realtime",objective:"Stay synchronized"},{"x-principal-id":alex.principal_id})).json();
    const room=(await post(`/v1/companies/${company.id}/projects/${project.id}/rooms`,{name:"Room One"},{"x-principal-id":alex.principal_id})).json();
    await post(`/v1/companies/${company.id}/rooms/${room.id}/members`,{principal_id:sarah.principal_id,role:"contributor"},{"x-principal-id":alex.principal_id,"idempotency-key":"add-sarah"});
    return {company,alex,sarah,project,room};
  }

  async function connect(companyId:string,roomId:string,principalId?:string,afterSeq?:number,autoAck=true) {
    const query=afterSeq===undefined?"":`?after_seq=${afterSeq}`;
    const client=new LiveClient(`${baseUrl.replace("http","ws")}/v1/companies/${companyId}/rooms/${roomId}/stream${query}`,principalId,autoAck);
    clients.add(client);
    await client.waitFor(f=>["snapshot","resumed","protocol_error","resync_required"].includes(f.type));
    return client;
  }

  async function message(s:any,text:string,key:string,actor=s.alex.principal_id) {
    return post(`/v1/companies/${s.company.id}/rooms/${s.room.id}/messages`,{body:text},{"x-principal-id":actor,"idempotency-key":key});
  }

  beforeEach(async()=>{
    const bootstrap=new Pool({connectionString});
    await bootstrap.query(await readFile("packages/db/schema.sql","utf8"));
    await bootstrap.query(`TRUNCATE command_receipts,room_events,messages,tasks,room_members,rooms,projects,principals,agents,company_users,users,companies CASCADE`);
    await bootstrap.end();
    await start();
  });

  afterEach(async()=>{
    for(const client of clients) client.close();
    clients.clear();
    await app.close();
  });

  it("keeps two clients synchronized and replays a disconnect window exactly once at application state",async()=>{
    const s=await setup();
    const a=await connect(s.company.id,s.room.id,s.alex.principal_id);
    const b=await connect(s.company.id,s.room.id,s.sarah.principal_id);
    const initial=a.lastSeq;
    expect(b.lastSeq).toBe(initial);

    await message(s,"one","sync-one");
    await a.waitFor(f=>f.type==="event"&&f.event.event_type==="message.sent");
    await b.waitFor(f=>f.type==="event"&&f.event.event_type==="message.sent");
    expect(a.lastSeq).toBe(initial+1);
    expect(b.lastSeq).toBe(a.lastSeq);

    const bBeforeDisconnect=[...b.applied.values()];
    const resumeFrom=b.lastSeq;
    b.close(); clients.delete(b);
    await Promise.all([message(s,"two","sync-two"),message(s,"three","sync-three"),message(s,"four","sync-four")]);
    await a.waitFor(f=>f.type==="event"&&f.event.room_seq===resumeFrom+3);

    const resumed=await connect(s.company.id,s.room.id,s.sarah.principal_id,resumeFrom);
    await resumed.waitFor(f=>f.type==="event"&&f.event.room_seq===resumeFrom+3);
    const bState=[...bBeforeDisconnect,...resumed.applied.values()];
    expect(new Set(bState.map(e=>e.room_seq)).size).toBe(bState.length);
    expect(bState.map(e=>e.room_seq)).toEqual([...a.applied.values()].map(e=>e.room_seq));
    expect(resumed.lastSeq).toBe(a.lastSeq);
    expect(resumed.gaps).toEqual([]);
  });

  it("deduplicates duplicate wakes and recovers ordered events from an out-of-order wake",async()=>{
    const s=await setup();
    const client=await connect(s.company.id,s.room.id,s.alex.principal_id);
    const start=client.lastSeq;
    await pool.query(`SELECT pg_notify('room_events',$1)`,[JSON.stringify({company_id:s.company.id,room_id:s.room.id,room_seq:start+99})]);
    await Promise.all([message(s,"first","dup-first"),message(s,"second","dup-second")]);
    await client.waitFor(f=>f.type==="event"&&f.event.room_seq===start+2);
    await pool.query(`SELECT pg_notify('room_events',$1),pg_notify('room_events',$1)`,[JSON.stringify({company_id:s.company.id,room_id:s.room.id,room_seq:start+2})]);
    await sleep(100);
    expect([...client.applied.keys()]).toEqual([start+1,start+2]);
    expect(client.gaps).toEqual([]);
  });

  it("replays from PostgreSQL after a gateway restart",async()=>{
    const s=await setup();
    const before=await connect(s.company.id,s.room.id,s.sarah.principal_id);
    const cursor=before.lastSeq;
    await restart();
    await message(s,"during restart one","restart-one");
    await message(s,"during restart two","restart-two");
    const resumed=await connect(s.company.id,s.room.id,s.sarah.principal_id,cursor);
    await resumed.waitFor(f=>f.type==="event"&&f.event.room_seq===cursor+2);
    expect([...resumed.applied.keys()]).toEqual([cursor+1,cursor+2]);
  });

  it("recovers a lost PostgreSQL notification through durable polling",async()=>{
    const s=await setup();
    await restart({listenNotifications:false,pollIntervalMs:20});
    const client=await connect(s.company.id,s.room.id,s.alex.principal_id);
    const cursor=client.lastSeq;
    await message(s,"poll me","lost-notify");
    await client.waitFor(f=>f.type==="event"&&f.event.room_seq===cursor+1);
    expect(client.lastSeq).toBe(cursor+1);
  });

  it("requires a fresh snapshot for stale or future cursors",async()=>{
    const s=await setup();
    await restart({maxReplayEvents:1});
    const stale=await connect(s.company.id,s.room.id,s.alex.principal_id,0);
    expect(await stale.waitFor(f=>f.type==="resync_required")).toMatchObject({reason:"stale_cursor"});
    const future=await connect(s.company.id,s.room.id,s.alex.principal_id,999);
    expect(await future.waitFor(f=>f.type==="resync_required")).toMatchObject({reason:"cursor_ahead"});
  });

  it("rejects unauthenticated, unauthorized, and cross-company subscriptions before sending room state",async()=>{
    const s=await setup();
    const missing=await connect(s.company.id,s.room.id,undefined);
    expect(await missing.waitFor(f=>f.type==="protocol_error")).toMatchObject({code:"unauthenticated"});
    const unknown=await connect(s.company.id,s.room.id,crypto.randomUUID());
    expect(await unknown.waitFor(f=>f.type==="protocol_error")).toMatchObject({code:"room_access_denied"});
    const other=(await post("/v1/companies",{name:"Other"})).json();
    const outsider=(await post(`/v1/companies/${other.id}/humans`,{email:`other-${crypto.randomUUID()}@example.com`,display_name:"Other"})).json();
    const cross=await connect(s.company.id,s.room.id,outsider.principal_id);
    expect(await cross.waitFor(f=>f.type==="protocol_error")).toMatchObject({code:"room_access_denied"});
    expect(cross.frames.some(f=>f.type==="snapshot"||f.type==="event")).toBe(false);
  });

  it("revokes an active socket when its room membership is removed",async()=>{
    const s=await setup();
    const member=await connect(s.company.id,s.room.id,s.sarah.principal_id);
    const removed=await app.inject({method:"DELETE",url:`/v1/companies/${s.company.id}/rooms/${s.room.id}/members/${s.sarah.principal_id}`,headers:{"x-principal-id":s.alex.principal_id,"idempotency-key":"remove-sarah"}});
    expect(removed.statusCode,removed.body).toBe(200);
    expect(await member.waitFor(f=>f.type==="access_revoked")).toMatchObject({room_id:s.room.id});
  });

  it("forces an unacknowledging slow client to resynchronize",async()=>{
    const s=await setup();
    await restart({maxUnackedEvents:1,pollIntervalMs:20});
    const slow=await connect(s.company.id,s.room.id,s.alex.principal_id,undefined,false);
    await message(s,"one","slow-one");
    await message(s,"two","slow-two");
    expect(await slow.waitFor(f=>f.type==="resync_required",4000)).toMatchObject({reason:"slow_client"});
  });

  it("does not mix concurrently active room streams",async()=>{
    const s=await setup();
    const roomTwo=(await post(`/v1/companies/${s.company.id}/projects/${s.project.id}/rooms`,{name:"Room Two"},{"x-principal-id":s.alex.principal_id})).json();
    const one=await connect(s.company.id,s.room.id,s.alex.principal_id);
    const two=await connect(s.company.id,roomTwo.id,s.alex.principal_id);
    await Promise.all([
      message(s,"only room one","room-one-event"),
      post(`/v1/companies/${s.company.id}/rooms/${roomTwo.id}/messages`,{body:"only room two"},{"x-principal-id":s.alex.principal_id,"idempotency-key":"room-two-event"}),
    ]);
    await one.waitFor(f=>f.type==="event"&&f.event.event_type==="message.sent");
    await two.waitFor(f=>f.type==="event"&&f.event.event_type==="message.sent");
    expect([...one.applied.values()].every(e=>e.payload.body_text==="only room one")).toBe(true);
    expect([...two.applied.values()].every(e=>e.payload.body_text==="only room two")).toBe(true);
  });
});
