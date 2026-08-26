import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';

const bridge=fileURLToPath(new URL('../bridge.mjs',import.meta.url));
const room='00000000-0000-4000-8000-000000000101';
const principal='00000000-0000-4000-8000-000000000102';
const peer='00000000-0000-4000-8000-000000000103';
const human='00000000-0000-4000-8000-000000000104';
const session='00000000-0000-4000-8000-000000000105';
const decisionId='00000000-0000-4000-8000-000000000106';
const taskId='00000000-0000-4000-8000-000000000107';
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitFor(check,label,timeout=8000){
  const started=Date.now();
  while(Date.now()-started<timeout){const value=check();if(value)return value;await delay(25)}
  throw new Error(`Timed out waiting for ${label}`);
}

function readJson(file){return fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):null}
function readLines(file){return fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)):[]}

async function scenario(name,{event,exitPlan=[0],send='live',duplicate=false,expectWake=true,inspectFailure=false}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),`mp-bridge-${name}-`));
  const identities=path.join(root,'identities');const runtime=path.join(root,'runtime');
  fs.mkdirSync(identities,{recursive:true});fs.mkdirSync(runtime,{recursive:true});
  const envFile=path.join(identities,'mock.env');
  const stateFile=path.join(runtime,'mock.state.json');
  const captureFile=path.join(root,'hermes-invocations.jsonl');
  const planFile=path.join(root,'hermes-exit-plan.json');
  const fakeHermes=path.join(root,'fake-hermes.mjs');
  const acks=[];let connectionUrl='';let socketRef=null;
  let snapshot={snapshot_seq:10,briefing:{important_recent_activity:[]},tasks:[{id:taskId,assignee_principal_id:principal,status:'awaiting_decision',version:3}]};
  const decision={id:decisionId,requested_by_principal_id:principal,status:event.payload?.status??'approved',version:2,resolution_note:'Approved. Proceed with the recommendation.'};

  fs.writeFileSync(planFile,JSON.stringify(exitPlan));
  fs.writeFileSync(fakeHermes,`#!/usr/bin/env node\nimport fs from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nconst capture=process.env.FAKE_HERMES_CAPTURE;\nconst prior=fs.existsSync(capture)?fs.readFileSync(capture,'utf8').trim().split('\\n').filter(Boolean).length:0;\nconst result=spawnSync(process.execPath,[process.env.TEST_BRIDGE,'snapshot','--env',process.env.TEST_ENV],{encoding:'utf8'});\nlet snapshot=null;try{snapshot=JSON.parse(result.stdout)}catch{}\nconst queryAt=process.argv.indexOf('-q');const prompt=queryAt>=0?process.argv[queryAt+1]:'';\nfs.appendFileSync(capture,JSON.stringify({invocation:prior+1,snapshot,prompt_has_event:prompt.includes(process.env.EXPECTED_EVENT_TYPE)})+'\\n');\nconst plan=JSON.parse(fs.readFileSync(process.env.FAKE_HERMES_EXIT_PLAN,'utf8'));\nprocess.exit(plan[Math.min(prior,plan.length-1)]??0);\n`,{mode:0o700});

  const server=http.createServer(async(req,res)=>{
    for await(const _ of req){}
    res.setHeader('content-type','application/json');
    if(req.url?.endsWith('/heartbeat'))return res.end(JSON.stringify({status:'connected'}));
    if(req.url?.endsWith('/snapshot'))return res.end(JSON.stringify(snapshot));
    if(req.url?.endsWith(`/decisions/${decisionId}`))return res.end(JSON.stringify(decision));
    res.statusCode=404;res.end(JSON.stringify({error:{code:'not_found',url:req.url}}));
  });
  const wss=new WebSocketServer({noServer:true});
  server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req)));
  wss.on('connection',(ws,req)=>{
    socketRef=ws;connectionUrl=req.url??'';
    ws.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame.type==='ack')acks.push(frame.room_seq)});
    ws.send(JSON.stringify({type:'session.ready',protocol:'agent-gateway.v1',session_id:session,room_id:room,agent_principal_id:principal,latest_seq:event.room_seq}));
    if(send==='replay'){
      snapshot={snapshot_seq:event.room_seq,briefing:{important_recent_activity:[event]},tasks:snapshot.tasks};
      ws.send(JSON.stringify({type:'room.event',room_id:room,event}));
    }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port;
  fs.writeFileSync(envFile,[`MULTIPLAYER_BASE_URL=http://127.0.0.1:${port}`,`MULTIPLAYER_ROOM_ID=${room}`,'MULTIPLAYER_PROFILE=mock',`MULTIPLAYER_AGENT_PRINCIPAL_ID=${principal}`,`MULTIPLAYER_PEER_PRINCIPAL_ID=${peer}`,'MULTIPLAYER_CREDENTIAL=magc_mock',`MULTIPLAYER_TASK_ID=${taskId}`,`HERMES_COMMAND=${fakeHermes}`].join('\n')+'\n',{mode:0o600});
  fs.writeFileSync(stateFile,JSON.stringify({last_contiguous_seq:10,processed_event_ids:[],pending_actionable_events:[],session_id:session,session_token:'mags_mock',room_id:room,agent_principal_id:principal,connection:'offline'},null,2)+'\n',{mode:0o600});

  const child=spawn(process.execPath,[bridge,'run','--env',envFile],{stdio:'ignore',env:{...process.env,FAKE_HERMES_CAPTURE:captureFile,FAKE_HERMES_EXIT_PLAN:planFile,TEST_BRIDGE:bridge,TEST_ENV:envFile,EXPECTED_EVENT_TYPE:event.event_type}});
  try{
    await waitFor(()=>socketRef,'websocket connection');
    if(send==='live'){
      await delay(100);
      snapshot={snapshot_seq:event.room_seq,briefing:{important_recent_activity:[event]},tasks:snapshot.tasks};
      socketRef.send(JSON.stringify({type:'room.event',room_id:room,event}));
    }
    await waitFor(()=>readJson(stateFile)?.last_contiguous_seq===event.room_seq&&acks.includes(event.room_seq),'cursor persistence and ACK');
    if(expectWake){
      if(inspectFailure){
        await waitFor(()=>readLines(captureFile).length>=1,'failed Hermes invocation');
        const failedState=readJson(stateFile);
        if(failedState.pending_actionable_events.length!==1)throw new Error(`${name}: failed invocation lost durable marker`);
      }
      const expected=exitPlan[0]===0?1:2;
      await waitFor(()=>readLines(captureFile).length>=expected,'Hermes invocation');
      await waitFor(()=>readJson(stateFile)?.pending_actionable_events?.length===0,'durable marker completion');
      const invocations=readLines(captureFile);
      if(invocations.length!==expected)throw new Error(`${name}: expected ${expected} wake(s), got ${invocations.length}`);
      const final=invocations.at(-1);
      if(final.snapshot?.snapshot_seq!==event.room_seq)throw new Error(`${name}: Hermes did not see updated snapshot`);
      if(!final.prompt_has_event)throw new Error(`${name}: Hermes prompt omitted actionable event`);
      if(duplicate){
        socketRef.send(JSON.stringify({type:'room.event',room_id:room,event}));
        await delay(1200);
        if(readLines(captureFile).length!==expected)throw new Error(`${name}: duplicate replay woke Hermes again`);
      }
    }else{
      await delay(1200);
      if(readLines(captureFile).length!==0)throw new Error(`${name}: irrelevant event woke Hermes`);
      if(readJson(stateFile).pending_actionable_events.length!==0)throw new Error(`${name}: irrelevant marker was not cleared`);
    }
    if(send==='replay'&&!connectionUrl.includes('after_seq=10'))throw new Error(`${name}: replay did not resume from cursor 10: ${connectionUrl}`);
    return {name,wakes:readLines(captureFile).length,ack:acks.at(-1),cursor:readJson(stateFile).last_contiguous_seq,replay:send==='replay'};
  }finally{
    child.kill('SIGTERM');await Promise.race([new Promise(resolve=>child.once('exit',resolve)),delay(1000)]);
    for(const client of wss.clients)client.terminate();wss.close();server.close();fs.rmSync(root,{recursive:true,force:true});
  }
}

const decisionEvent=(type,seq=11)=>({id:`event-${type}-${seq}`,room_seq:seq,event_type:type,actor_principal_id:type==='decision.expired'?principal:human,actor_kind:type==='decision.expired'?'agent':'human',entity_type:'decision',entity_id:decisionId,payload:{decision_id:decisionId,status:type.split('.')[1],resolved_by_principal_id:human,resolution_note:'Approved. Proceed with the recommendation.'}});

const results=[];
results.push(await scenario('live-approved',{event:decisionEvent('decision.approved'),send:'live'}));
results.push(await scenario('offline-replay-approved',{event:decisionEvent('decision.approved'),send:'replay'}));
for(const type of ['decision.rejected','decision.cancelled','decision.expired'])results.push(await scenario(type.replace('.','-'),{event:decisionEvent(type),send:'live'}));
results.push(await scenario('duplicate-approved',{event:decisionEvent('decision.approved'),send:'live',duplicate:true}));
results.push(await scenario('hermes-failure-retry',{event:decisionEvent('decision.approved'),send:'live',exitPlan:[1,0],inspectFailure:true}));
results.push(await scenario('addressed-message',{event:{id:'event-addressed-message-11',room_seq:11,event_type:'message.sent',actor_principal_id:peer,actor_kind:'agent',entity_type:'message',entity_id:'00000000-0000-4000-8000-000000000108',payload:{addressed_principal_id:principal,body_text:'directly for this agent'}},send:'live'}));
results.push(await scenario('human-redirect-message',{event:{id:'event-human-message-11',room_seq:11,event_type:'message.sent',actor_principal_id:human,actor_kind:'human',entity_type:'message',entity_id:'00000000-0000-4000-8000-000000000109',payload:{body_text:'human redirect'}},send:'live'}));
results.push(await scenario('task-assignment',{event:{id:'event-task-created-11',room_seq:11,event_type:'task.created',actor_principal_id:human,actor_kind:'human',entity_type:'task',entity_id:taskId,payload:{id:taskId,assignee_principal_id:principal,status:'open',version:1}},send:'live'}));
results.push(await scenario('task-update',{event:{id:'event-task-update-11',room_seq:11,event_type:'task.blocked',actor_principal_id:human,actor_kind:'human',entity_type:'task',entity_id:taskId,payload:{id:taskId,status:'blocked',version:4}},send:'live'}));
results.push(await scenario('irrelevant-addressed-message',{event:{id:'event-message-11',room_seq:11,event_type:'message.sent',actor_principal_id:peer,actor_kind:'agent',entity_type:'message',entity_id:'00000000-0000-4000-8000-000000000110',payload:{addressed_principal_id:peer,body_text:'not for this agent'}},send:'live',expectWake:false}));
console.log(JSON.stringify({decision_resume_tests_passed:true,real_room_touched:false,results}));
