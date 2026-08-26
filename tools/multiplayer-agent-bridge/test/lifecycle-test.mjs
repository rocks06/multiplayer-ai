// Persistent-runtime lifecycle coverage for the external agent bridge.
// Every scenario drives the real bridge process against a controllable mock Gateway and a
// fake Hermes; no real room, credential, or model is touched.
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';

const bridge=fileURLToPath(new URL('../bridge.mjs',import.meta.url));
const room='00000000-0000-4000-8000-000000000201';
const principal='00000000-0000-4000-8000-000000000202';
const peer='00000000-0000-4000-8000-000000000203';
const human='00000000-0000-4000-8000-000000000204';
const taskA='00000000-0000-4000-8000-00000000020a';
const taskB='00000000-0000-4000-8000-00000000020b';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(check,label,timeout=20000){
  const started=Date.now();
  let last;
  while(Date.now()-started<timeout){
    last=check();
    if(last)return last;
    await delay(25);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
const readJson=file=>fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null;
const readLines=file=>fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[];
const taskEvent=(seq,id,assignee)=>({id:`event-${id}-${seq}`,room_seq:seq,event_type:'task.created',actor_principal_id:human,actor_kind:'human',entity_type:'task',entity_id:id,payload:{id,title:`Task ${id.slice(-1)}`,status:'open',version:1,assignee_principal_id:assignee}});

class Gateway {
  constructor(){
    this.sessions=new Map();
    this.issued=0;
    this.acks=[];
    this.connections=[];
    this.sockets=new Set();
    this.snapshot={snapshot_seq:10,tasks:[],briefing:{important_recent_activity:[]}};
    this.port=0;
  }
  session(id){return this.sessions.get(id)}
  async start(port=0){
    this.server=http.createServer(async(req,res)=>{
      for await(const _ of req){}
      res.setHeader('content-type','application/json');
      const url=req.url??'';
      const send=value=>res.end(JSON.stringify(value));
      if(url==='/v1/agent-gateway/v1/rooms')return send({agent_principal_id:principal,rooms:[{id:room,last_event_seq:this.snapshot.snapshot_seq}]});
      if(url==='/v1/agent-gateway/v1/sessions'&&req.method==='POST'){
        const id=`00000000-0000-4000-8000-00000000030${++this.issued}`;
        this.sessions.set(id,{id,token:`mags_${this.issued}`,status:'connected',runtime_status:'idle',last_ack:0});
        return send({session_id:id,session_token:`mags_${this.issued}`,room_id:room,agent_principal_id:principal});
      }
      const match=/^\/v1\/agent-gateway\/v1\/sessions\/([^/?]+)(\/[^?]*)?/.exec(url);
      const record=match?this.sessions.get(match[1]):null;
      if(match&&!record){res.statusCode=401;return send({error:{code:'gateway_session_invalid',message:'Session is invalid'}})}
      const suffix=match?.[2]??'';
      if(suffix==='/heartbeat')return send({status:'connected'});
      if(suffix==='/snapshot')return send(this.snapshot);
      if(suffix==='/tasks')return send(this.snapshot.tasks.filter(task=>task.assignee_principal_id===principal));
      if(match&&!suffix)return send({session_id:record.id,status:record.status,runtime_status:record.runtime_status,last_ack_room_seq:record.last_ack,room_last_event_seq:this.snapshot.snapshot_seq,last_seen_at:new Date().toISOString()});
      res.statusCode=404;send({error:{code:'not_found',url}});
    });
    this.wss=new WebSocketServer({noServer:true});
    this.server.on('upgrade',(req,socket,head)=>{
      const id=/\/sessions\/([^/?]+)\/stream/.exec(req.url??'')?.[1];
      const record=id?this.sessions.get(id):null;
      this.wss.handleUpgrade(req,socket,head,ws=>{
        if(!record){
          ws.send(JSON.stringify({type:'protocol_error',code:'gateway_session_invalid',message:'Session is invalid'}));
          ws.close(4401,'subscription_rejected');
          return;
        }
        this.connections.push(req.url??'');
        this.sockets.add(ws);
        ws.on('close',()=>this.sockets.delete(ws));
        ws.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame.type==='ack'){this.acks.push(frame.room_seq);record.last_ack=frame.room_seq}});
        ws.send(JSON.stringify({type:'session.ready',protocol:'agent-gateway.v1',session_id:record.id,room_id:room,agent_principal_id:principal,latest_seq:this.snapshot.snapshot_seq}));
      });
    });
    await new Promise(resolve=>this.server.listen(port,'127.0.0.1',resolve));
    this.port=this.server.address().port;
    return this.port;
  }
  async stop(){
    for(const ws of this.sockets)ws.terminate();
    this.sockets.clear();
    this.wss?.close();
    await new Promise(resolve=>this.server.close(resolve));
  }
  drop(){for(const ws of this.sockets)ws.close()}
  emit(event){this.snapshot.snapshot_seq=event.room_seq;for(const ws of this.sockets)ws.send(JSON.stringify({type:'room.event',room_id:room,event}))}
}

function workspace(name,{exitPlan=[0]}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`mp-lifecycle-${name}-`));
  const identities=path.join(root,'identities');
  const runtime=path.join(root,'runtime');
  fs.mkdirSync(identities,{recursive:true});fs.mkdirSync(runtime,{recursive:true});
  const envFile=path.join(identities,'mock.env');
  const stateFile=path.join(runtime,'mock.state.json');
  const captureFile=path.join(root,'hermes.jsonl');
  const planFile=path.join(root,'plan.json');
  const fakeHermes=path.join(root,'fake-hermes.mjs');
  fs.writeFileSync(planFile,JSON.stringify(exitPlan));
  fs.writeFileSync(fakeHermes,`#!/usr/bin/env node\nimport fs from 'node:fs';\nconst capture=process.env.FAKE_HERMES_CAPTURE;\nconst prior=fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\\n').filter(Boolean).length:0;\nconst at=process.argv.indexOf('-q');\nfs.appendFileSync(capture,JSON.stringify({invocation:prior+1,prompt:at>=0?process.argv[at+1]:''})+'\\n');\nconst plan=JSON.parse(fs.readFileSync(process.env.FAKE_HERMES_EXIT_PLAN,'utf8'));\nprocess.exit(plan[Math.min(prior,plan.length-1)]??0);\n`,{mode:0o700});
  return {root,envFile,stateFile,captureFile,planFile,fakeHermes,
    writeEnv:port=>fs.writeFileSync(envFile,[`MULTIPLAYER_BASE_URL=http://127.0.0.1:${port}`,`MULTIPLAYER_ROOM_ID=${room}`,'MULTIPLAYER_PROFILE=mock',`MULTIPLAYER_AGENT_PRINCIPAL_ID=${principal}`,`MULTIPLAYER_PEER_PRINCIPAL_ID=${peer}`,'MULTIPLAYER_CREDENTIAL=magc_mock','MULTIPLAYER_HTTP_TIMEOUT_MS=1500','MULTIPLAYER_RECONNECT_BASE_MS=200','MULTIPLAYER_RECONNECT_MAX_MS=800','MULTIPLAYER_WS_PING_MS=1000'].join('\n')+'\n',{mode:0o600}),
    seedState:cursor=>fs.writeFileSync(stateFile,JSON.stringify({last_contiguous_seq:cursor,processed_event_ids:[],pending_actionable_events:[]},null,2)+'\n',{mode:0o600}),
    start:()=>spawn(process.execPath,[bridge,'run','--env',envFile],{stdio:'ignore',env:{...process.env,FAKE_HERMES_CAPTURE:captureFile,FAKE_HERMES_EXIT_PLAN:planFile,HERMES_COMMAND:fakeHermes}}),
    cleanup:()=>fs.rmSync(root,{recursive:true,force:true})};
}
const stopChild=async child=>{if(!child||child.exitCode!==null)return;child.kill('SIGKILL');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(2000)])};

const results=[];

// Sequential tasks: Task B must be discovered and keyed independently of Task A, with no
// change to the identity file between them.
{
  const gateway=new Gateway();const port=await gateway.start();
  const ws=workspace('sequential-tasks');ws.writeEnv(port);ws.seedState(10);
  gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'open',version:1}];
  const envBefore=fs.readFileSync(ws.envFile,'utf8');
  const child=ws.start();
  try{
    await waitFor(()=>gateway.sockets.size===1,'initial connection');
    gateway.emit(taskEvent(11,taskA,principal));
    await waitFor(()=>readLines(ws.captureFile).length>=1,'wake for task A');
    gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'completed',version:3},{id:taskB,title:'Task B',assignee_principal_id:principal,status:'open',version:1}];
    gateway.emit(taskEvent(12,taskB,principal));
    await waitFor(()=>readLines(ws.captureFile).length>=2,'wake for task B');
    await delay(400);
    const [first,second]=readLines(ws.captureFile);
    if(readLines(ws.captureFile).length!==2)throw new Error('sequential-tasks: unexpected extra wake');
    if(!first.prompt.includes(`mock-${taskA}-start-v1`))throw new Error('sequential-tasks: task A keys missing');
    if(first.prompt.includes(taskB))throw new Error('sequential-tasks: task A wake leaked task B');
    if(!second.prompt.includes(`mock-${taskB}-start-v1`))throw new Error('sequential-tasks: task B keys missing');
    if(second.prompt.includes(`mock-${taskA}-`))throw new Error('sequential-tasks: task B reused task A idempotency keys');
    if(fs.readFileSync(ws.envFile,'utf8')!==envBefore)throw new Error('sequential-tasks: identity file changed between tasks');
    if(envBefore.includes('MULTIPLAYER_TASK_ID'))throw new Error('sequential-tasks: runtime still configured with a static task id');
    results.push({name:'sequential-tasks-no-key-collision',wakes:2,task_a_keyed:true,task_b_keyed:true,env_unchanged:true});
  }finally{await stopChild(child);await gateway.stop();ws.cleanup()}
}

// WebSocket dropped mid-life: the bridge reconnects on its own and resumes from its
// persisted contiguous cursor.
{
  const gateway=new Gateway();const port=await gateway.start();
  const ws=workspace('websocket-drop');ws.writeEnv(port);ws.seedState(10);
  gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'open',version:1}];
  const child=ws.start();
  try{
    await waitFor(()=>gateway.sockets.size===1,'initial connection');
    gateway.emit(taskEvent(11,taskA,principal));
    await waitFor(()=>gateway.acks.includes(11),'ack 11');
    await waitFor(()=>readLines(ws.captureFile).length>=1,'wake before drop');
    const before=gateway.connections.length;
    gateway.drop();
    const resumed=await waitFor(()=>gateway.connections.length>before?gateway.connections.at(-1):null,'reconnect');
    if(!resumed.includes('after_seq=11'))throw new Error(`websocket-drop: resumed from wrong cursor: ${resumed}`);
    gateway.snapshot.tasks=[{id:taskB,title:'Task B',assignee_principal_id:principal,status:'open',version:1}];
    gateway.emit(taskEvent(12,taskB,principal));
    await waitFor(()=>readLines(ws.captureFile).length>=2,'wake after reconnect');
    await delay(400);
    if(readLines(ws.captureFile).length!==2)throw new Error('websocket-drop: replay duplicated a wake');
    if(readJson(ws.stateFile).last_contiguous_seq!==12)throw new Error('websocket-drop: cursor did not advance');
    results.push({name:'websocket-drop-reconnect-replay',reconnected:true,resumed_after_seq:11,wakes:2});
  }finally{await stopChild(child);await gateway.stop();ws.cleanup()}
}

// Gateway process disappears entirely and comes back on the same address. No human action.
{
  const gateway=new Gateway();const port=await gateway.start();
  const ws=workspace('gateway-outage');ws.writeEnv(port);ws.seedState(10);
  gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'open',version:1}];
  const child=ws.start();
  try{
    await waitFor(()=>gateway.sockets.size===1,'initial connection');
    const before=gateway.connections.length;
    await gateway.stop();
    await delay(1500);
    if(readJson(ws.stateFile).connection==='live')throw new Error('gateway-outage: reported live while the Gateway was down');
    await gateway.start(port);
    await waitFor(()=>gateway.connections.length>before,'reconnect after outage');
    await waitFor(()=>readJson(ws.stateFile)?.connection==='live','live again');
    gateway.emit(taskEvent(11,taskA,principal));
    await waitFor(()=>readLines(ws.captureFile).length>=1,'wake after recovery');
    results.push({name:'gateway-outage-recovery',reconnected_without_operator:true,wakes:1});
  }finally{await stopChild(child);await gateway.stop();ws.cleanup()}
}

// The Gateway forgets the session (restart with lost session state). Retrying the same id can
// never succeed, so the bridge must open a fresh session and replay from its own cursor.
{
  const gateway=new Gateway();const port=await gateway.start();
  const ws=workspace('session-invalidated');ws.writeEnv(port);ws.seedState(10);
  gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'open',version:1}];
  const child=ws.start();
  try{
    await waitFor(()=>gateway.sockets.size===1,'initial connection');
    const firstSession=readJson(ws.stateFile).session_id;
    gateway.sessions.clear();
    gateway.drop();
    await waitFor(()=>gateway.issued>=2,'new session opened');
    await waitFor(()=>gateway.sockets.size===1,'reconnect on new session');
    const secondSession=readJson(ws.stateFile).session_id;
    if(!secondSession||secondSession===firstSession)throw new Error('session-invalidated: bridge kept retrying the dead session');
    const resumed=gateway.connections.at(-1);
    if(!resumed.includes('after_seq=10'))throw new Error(`session-invalidated: lost cursor on re-session: ${resumed}`);
    gateway.emit(taskEvent(11,taskA,principal));
    await waitFor(()=>readLines(ws.captureFile).length>=1,'wake on new session');
    results.push({name:'session-invalidated-reopens',new_session:true,cursor_preserved:10,wakes:1});
  }finally{await stopChild(child);await gateway.stop();ws.cleanup()}
}

// A slept laptop or a dropped route leaves the socket open but silent in both directions,
// with no close event. Only unanswered pings can reveal it. A frozen TCP proxy reproduces
// that exactly, without needing the OS to actually suspend.
{
  const gateway=new Gateway();const upstream=await gateway.start();
  let frozen=false;const pipes=new Set();
  const proxy=net.createServer(client=>{
    const server=net.connect(upstream,'127.0.0.1');
    const pair={client,server};pipes.add(pair);
    client.on('data',chunk=>{if(!frozen)server.write(chunk)});
    server.on('data',chunk=>{if(!frozen)client.write(chunk)});
    const drop=()=>{pipes.delete(pair);client.destroy();server.destroy()};
    client.on('error',drop);server.on('error',drop);
    client.on('close',()=>{pipes.delete(pair);server.destroy()});
    server.on('close',()=>{pipes.delete(pair);client.destroy()});
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const ws=workspace('half-open');ws.writeEnv(proxy.address().port);ws.seedState(10);
  gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'open',version:1}];
  const child=ws.start();
  try{
    await waitFor(()=>gateway.sockets.size===1,'initial connection');
    const before=gateway.connections.length;
    frozen=true;
    // The Gateway still believes the old socket is open; nothing will close it for us.
    await waitFor(()=>readJson(ws.stateFile)?.connection==='stalled','stall detection',12000);
    frozen=false;for(const pair of pipes){pair.client.destroy();pair.server.destroy()}pipes.clear();
    await waitFor(()=>gateway.connections.length>before,'reconnect after stall',12000);
    await waitFor(()=>readJson(ws.stateFile)?.connection==='live','live after stall');
    gateway.emit(taskEvent(11,taskA,principal));
    await waitFor(()=>readLines(ws.captureFile).length>=1,'wake after stall recovery');
    results.push({name:'half-open-socket-detected',stall_detected:true,reconnected_without_operator:true,wakes:1});
  }finally{await stopChild(child);await new Promise(resolve=>proxy.close(resolve));await gateway.stop();ws.cleanup()}
}

// Hard crash between ACK and successful Hermes processing: the durable marker must survive
// the restart and be processed exactly once.
{
  const gateway=new Gateway();const port=await gateway.start();
  const ws=workspace('crash-restart',{exitPlan:[1]});ws.writeEnv(port);ws.seedState(10);
  gateway.snapshot.tasks=[{id:taskA,title:'Task A',assignee_principal_id:principal,status:'open',version:1}];
  let child=ws.start();
  try{
    await waitFor(()=>gateway.sockets.size===1,'initial connection');
    gateway.emit(taskEvent(11,taskA,principal));
    await waitFor(()=>gateway.acks.includes(11),'ack 11');
    await waitFor(()=>readLines(ws.captureFile).length>=1,'failing Hermes invocation');
    await waitFor(()=>readJson(ws.stateFile)?.pending_actionable_events?.length===1,'marker retained after failure');
    await stopChild(child);
    const persisted=readJson(ws.stateFile);
    if(persisted.pending_actionable_events.length!==1)throw new Error('crash-restart: marker lost on crash');
    if(persisted.last_contiguous_seq!==11)throw new Error('crash-restart: cursor lost on crash');
    fs.writeFileSync(ws.planFile,JSON.stringify([0]));
    const failedWakes=readLines(ws.captureFile).length;
    child=ws.start();
    await waitFor(()=>readLines(ws.captureFile).length>failedWakes,'wake after restart');
    await waitFor(()=>readJson(ws.stateFile)?.pending_actionable_events?.length===0,'marker cleared after success');
    await delay(500);
    if(readJson(ws.stateFile).pending_actionable_events.length!==0)throw new Error('crash-restart: marker resurrected');
    results.push({name:'marker-survives-process-restart',marker_recovered:true,cursor_preserved:11});
  }finally{await stopChild(child);await gateway.stop();ws.cleanup()}
}

console.log(JSON.stringify({lifecycle_tests_passed:true,real_room_touched:false,results}));
