#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const die=(message,code=1)=>{console.error(message);process.exit(code)};
const json=value=>console.log(JSON.stringify(value,null,2));

function args(argv){
  const out={_:[]};
  for(let i=0;i<argv.length;i++){
    const item=argv[i];
    if(!item.startsWith('--')){out._.push(item);continue}
    const key=item.slice(2);
    const next=argv[i+1];
    if(next!==undefined&&!next.startsWith('--')){out[key]=next;i++}else out[key]=true;
  }
  return out;
}

function loadEnv(file){
  const values={};
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line||line.trimStart().startsWith('#')||!line.includes('='))continue;
    const at=line.indexOf('=');values[line.slice(0,at).trim()]=line.slice(at+1).trim();
  }
  return values;
}

function secureWrite(file,value){
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  const temp=`${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{mode:0o600});
  fs.chmodSync(temp,0o600);fs.renameSync(temp,file);
}

const cli=args(process.argv.slice(2));
const command=cli._[0]??'help';
const envInput=String(cli.env??process.env.MULTIPLAYER_ENV_FILE??'');
if(command!=='help'&&!envInput)die('Use --env /absolute/path/to/<agent>.env');
const envFile=envInput?path.resolve(envInput):'';
const config=command==='help'?{}:{...loadEnv(envFile),...process.env};
const required=['MULTIPLAYER_BASE_URL','MULTIPLAYER_ROOM_ID','MULTIPLAYER_PROFILE','MULTIPLAYER_AGENT_PRINCIPAL_ID','MULTIPLAYER_PEER_PRINCIPAL_ID','MULTIPLAYER_CREDENTIAL'];
if(command!=='help')for(const key of required)if(!config[key])die(`Missing ${key} in ${envFile}`);
const home=path.dirname(path.dirname(envFile));
const runtimeDir=path.join(home,'runtime');
const stateFile=path.join(runtimeDir,`${config.MULTIPLAYER_PROFILE}.state.json`);
const pidFile=path.join(runtimeDir,`${config.MULTIPLAYER_PROFILE}.pid`);
const logFile=path.join(runtimeDir,`${config.MULTIPLAYER_PROFILE}.log`);
const bridgeFile=path.resolve(process.argv[1]);
let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{last_contiguous_seq:null,processed_event_ids:[],pending_actionable_events:[]};
state.processed_event_ids=Array.isArray(state.processed_event_ids)?state.processed_event_ids:[];
state.pending_actionable_events=Array.isArray(state.pending_actionable_events)?state.pending_actionable_events:[];
let activeHermesChild=null;
const save=()=>secureWrite(stateFile,state);

async function http(method,route,body,token,idempotencyKey){
  const headers={authorization:`Bearer ${token}`};
  if(body!==undefined)headers['content-type']='application/json';
  if(idempotencyKey)headers['idempotency-key']=idempotencyKey;
  const response=await fetch(`${config.MULTIPLAYER_BASE_URL}${route}`,{method,headers,body:body===undefined?undefined:JSON.stringify(body)});
  const text=await response.text();
  let value;try{value=text?JSON.parse(text):{}}catch{value={raw:text}}
  if(!response.ok){const error=new Error(`Gateway HTTP ${response.status}: ${value?.error?.code??'request_failed'} ${value?.error?.message??''}`);error.status=response.status;error.body=value;throw error}
  return value;
}

async function openSession(){
  const rooms=await http('GET','/v1/agent-gateway/v1/rooms',undefined,config.MULTIPLAYER_CREDENTIAL);
  if(rooms.agent_principal_id!==config.MULTIPLAYER_AGENT_PRINCIPAL_ID)throw new Error('Credential principal does not match local configuration');
  if(!rooms.rooms.some(room=>room.id===config.MULTIPLAYER_ROOM_ID))throw new Error('Configured room is not authorized for this credential');
  const opened=await http('POST','/v1/agent-gateway/v1/sessions',{room_id:config.MULTIPLAYER_ROOM_ID,runtime_status:'idle'},config.MULTIPLAYER_CREDENTIAL);
  state={...state,session_id:opened.session_id,session_token:opened.session_token,room_id:opened.room_id,agent_principal_id:opened.agent_principal_id,connection:'created'};
  save();return state;
}
async function ensureSession(){if(!state.session_id||!state.session_token)await openSession();return state}
const sessionRoute=suffix=>`/v1/agent-gateway/v1/sessions/${state.session_id}${suffix}`;
async function sessionHttp(method,suffix,body,key){await ensureSession();return http(method,sessionRoute(suffix),body,state.session_token,key)}

function need(name){const value=cli[name];if(value===undefined||value===true)die(`--${name} is required`);return String(value)}
const numeric=name=>{const value=Number(need(name));if(!Number.isInteger(value)||value<0)die(`--${name} must be a non-negative integer`);return value};

async function action(){
  if(command==='help')return console.log(`Usage: node bridge.mjs <command> --env FILE [options]\n\nDaemon: run | status | stop\nAgent actions: snapshot | tasks | task --id ID | message --body TEXT [--to ID] [--task ID] --key KEY | task-status --id ID --status STATUS --version N --key KEY | task-complete --id ID --version N --key KEY | decision-request --title TEXT --question TEXT --rationale TEXT --proposed-action-json JSON --key KEY | decision-get --id ID | heartbeat --runtime-status idle|working`);
  if(command==='check')return json({valid:true,profile:config.MULTIPLAYER_PROFILE,base_url:config.MULTIPLAYER_BASE_URL,room_id:config.MULTIPLAYER_ROOM_ID,agent_principal_id:config.MULTIPLAYER_AGENT_PRINCIPAL_ID,credential_present:true,credential_value_exposed:false});
  if(command==='status')return json({profile:config.MULTIPLAYER_PROFILE,room_id:config.MULTIPLAYER_ROOM_ID,agent_principal_id:config.MULTIPLAYER_AGENT_PRINCIPAL_ID,session_id:state.session_id??null,connection:state.connection??'not_started',last_contiguous_seq:state.last_contiguous_seq??null,pending_actionable_events:state.pending_actionable_events.length,pid:fs.existsSync(pidFile)?Number(fs.readFileSync(pidFile,'utf8')):null});
  if(command==='stop'){
    if(!fs.existsSync(pidFile))return json({stopped:false,reason:'not_running'});
    const pid=Number(fs.readFileSync(pidFile,'utf8'));try{process.kill(pid,'SIGTERM');return json({stopped:true,pid})}catch{return json({stopped:false,reason:'stale_pid',pid})}
  }
  if(command==='snapshot')return json(await sessionHttp('GET','/snapshot'));
  if(command==='tasks')return json(await sessionHttp('GET','/tasks'));
  if(command==='task')return json(await sessionHttp('GET',`/tasks/${need('id')}`));
  if(command==='message')return json(await sessionHttp('POST','/messages',{body:need('body'),...(cli.to?{addressed_principal_id:String(cli.to)}:{}),...(cli.task?{task_id:String(cli.task)}:{})},need('key')));
  if(command==='task-status')return json(await sessionHttp('PATCH',`/tasks/${need('id')}/status`,{status:need('status'),expected_version:numeric('version')},need('key')));
  if(command==='task-complete')return json(await sessionHttp('POST',`/tasks/${need('id')}/complete`,{expected_version:numeric('version')},need('key')));
  if(command==='decision-request'){
    let proposed;try{proposed=JSON.parse(need('proposed-action-json'))}catch{die('--proposed-action-json must be valid JSON')}
    return json(await sessionHttp('POST','/decisions',{title:need('title'),question:need('question'),rationale:String(cli.rationale??''),proposed_action:proposed},need('key')));
  }
  if(command==='decision-get')return json(await sessionHttp('GET',`/decisions/${need('id')}`));
  if(command==='heartbeat')return json(await sessionHttp('POST','/heartbeat',{runtime_status:need('runtime-status')}));
  if(command==='run')return runDaemon();
  die(`Unknown command: ${command}`);
}

function promptFor(trigger){
  const profile=config.MULTIPLAYER_PROFILE;
  const taskId=config.MULTIPLAYER_TASK_ID??'<read with tasks>';
  const tool=`node ${JSON.stringify(bridgeFile)} COMMAND --env ${JSON.stringify(envFile)}`;
  const stable=profile==='coleman'?{
    start:`coleman-${taskId}-start-v1`,message:`coleman-${taskId}-findings-v1`,complete:`coleman-${taskId}-complete-v1`
  }:{start:`jj-${taskId}-start-v1`,decision:`jj-${taskId}-decision-v1`,awaiting:`jj-${taskId}-awaiting-v1`,final:`jj-${taskId}-final-v1`,complete:`jj-${taskId}-complete-v1`};
  const workflow=profile==='coleman'?
`You are Coleman Agent. Work only on your assigned eligible task. Read snapshot, tasks, and the assigned task. Mark it in_progress with key ${stable.start}. Investigate the requested technical constraints using the accepted local project if useful. Send exactly one concise findings message addressed to peer principal ${config.MULTIPLAYER_PEER_PRINCIPAL_ID} and tied to the task, using key ${stable.message}. Then complete the task with key ${stable.complete}. Before each task mutation, re-read the task and use its current version. Do not request a human decision.`:
`You are JJ Agent. Work only on your assigned eligible task. Read snapshot, tasks, and the assigned task. Mark it in_progress once with key ${stable.start}. Do NOT make a final recommendation until Coleman's addressed findings are present in the room snapshot. If they are absent, stop cleanly and wait for another wake. When they arrive, synthesize the scoped recommendation, request exactly one structured human decision with key ${stable.decision}, then mark the task awaiting_decision with key ${stable.awaiting}. While the decision is pending, stop cleanly. After a durable approved/rejected resolution is visible, post exactly one final recommendation incorporating that outcome with key ${stable.final}, then complete the task with key ${stable.complete}. Before each task mutation, re-read the task and use its current version.`;
  return `You are an external Hermes runtime connected as ${profile} to Multiplayer AI Agent Gateway v1.\n\n${workflow}\n\nUse the terminal to call only this narrow bridge command:\n${tool}\nAvailable COMMAND values: snapshot, tasks, task --id ID, message --body TEXT [--to ID] [--task ID] --key KEY, task-status --id ID --status STATUS --version N --key KEY, task-complete --id ID --version N --key KEY, decision-request --title TEXT --question TEXT --rationale TEXT --proposed-action-json JSON --key KEY, decision-get --id ID.\nNever read or print the credential file. Never use curl, direct database access, x-principal-id, or any identity other than this configured bridge. Treat PostgreSQL room state as authoritative. Idempotency keys shown above are mandatory and must be reused exactly across retries. If an operation reports an optimistic-version conflict, re-read and reconcile; do not duplicate effects.\n\nWake reason:\n${JSON.stringify(trigger).slice(0,12000)}`;
}

async function runHermes(trigger){
  state.hermes_running=true;state.last_wake_at=new Date().toISOString();save();
  await sessionHttp('POST','/heartbeat',{runtime_status:'working'}).catch(()=>{});
  const log=fs.openSync(logFile,'a',0o600);
  const hermes=config.HERMES_COMMAND??'hermes';
  const child=spawn(hermes,['chat','-q',promptFor(trigger),'--toolsets','terminal,file,web','--source',`multiplayer-${config.MULTIPLAYER_PROFILE}`,'--quiet'],{stdio:['ignore',log,log],env:{...process.env}});
  activeHermesChild=child;
  const code=await new Promise(resolve=>child.once('exit',value=>resolve(value??1)));
  activeHermesChild=null;
  fs.closeSync(log);state.hermes_running=false;state.last_hermes_exit=code;save();
  await sessionHttp('POST','/heartbeat',{runtime_status:'idle'}).catch(()=>{});
  return code;
}

const decisionResolutionEvents=new Set(['decision.approved','decision.rejected','decision.cancelled','decision.expired']);
const eventKey=event=>String(event.id??`room-seq:${event.room_seq}`);
function isActionableCandidate(event){
  if(decisionResolutionEvents.has(event.event_type))return true;
  if(event.actor_principal_id===config.MULTIPLAYER_AGENT_PRINCIPAL_ID)return false;
  if(event.event_type==='message.sent')return true;
  if(String(event.event_type??'').startsWith('task.'))return true;
  return ['human.redirect','agent.redirected'].includes(event.event_type);
}

async function isRelevantActionable(marker){
  if(marker.type==='room.snapshot')return true;
  const event=marker.event;
  if(decisionResolutionEvents.has(event.event_type)){
    const decisionId=event.payload?.decision_id??event.entity_id;
    if(!decisionId)return false;
    const decision=await sessionHttp('GET',`/decisions/${decisionId}`);
    return decision.requested_by_principal_id===config.MULTIPLAYER_AGENT_PRINCIPAL_ID;
  }
  if(event.event_type==='message.sent'){
    const addressed=event.payload?.addressed_principal_id;
    return addressed===config.MULTIPLAYER_AGENT_PRINCIPAL_ID || (event.actor_kind==='human' && !addressed);
  }
  if(String(event.event_type??'').startsWith('task.')){
    if(event.payload?.assignee_principal_id)return event.payload.assignee_principal_id===config.MULTIPLAYER_AGENT_PRINCIPAL_ID;
    const snapshot=await sessionHttp('GET','/snapshot');
    const task=snapshot.tasks?.find(item=>item.id===(event.entity_id??event.payload?.id));
    return task?.assignee_principal_id===config.MULTIPLAYER_AGENT_PRINCIPAL_ID;
  }
  const target=event.payload?.agent_principal_id??event.payload?.target_principal_id??event.payload?.addressed_principal_id;
  return target===config.MULTIPLAYER_AGENT_PRINCIPAL_ID;
}

async function runDaemon(){
  fs.mkdirSync(runtimeDir,{recursive:true,mode:0o700});
  if(fs.existsSync(pidFile)){
    const old=Number(fs.readFileSync(pidFile,'utf8'));try{process.kill(old,0);die(`Bridge already running with PID ${old}`)}catch{}
  }
  fs.writeFileSync(pidFile,String(process.pid)+'\n',{mode:0o600});
  let stopping=false,socket=null,wakeTimer=null,hermesBusy=false,retryDelay=1000;
  const cleanup=()=>{stopping=true;if(wakeTimer)clearTimeout(wakeTimer);if(activeHermesChild)activeHermesChild.kill('SIGTERM');if(socket)socket.close();try{fs.unlinkSync(pidFile)}catch{};state.connection='offline';save()};
  process.on('SIGTERM',()=>{cleanup();process.exit(0)});process.on('SIGINT',()=>{cleanup();process.exit(0)});
  const rememberActionable=marker=>{
    if(!state.pending_actionable_events.some(item=>item.key===marker.key))state.pending_actionable_events.push(marker);
    save();
  };
  const scheduleWake=(delay=750)=>{
    if(stopping||wakeTimer||hermesBusy||!state.pending_actionable_events.length)return;
    wakeTimer=setTimeout(()=>{wakeTimer=null;void drainPending()},delay);
  };
  const drainPending=async()=>{
    if(stopping||hermesBusy||!state.pending_actionable_events.length)return;
    hermesBusy=true;
    const candidates=[...state.pending_actionable_events];
    const relevant=[];
    const irrelevant=[];
    try{
      for(const marker of candidates){
        if(await isRelevantActionable(marker))relevant.push(marker);else irrelevant.push(marker);
      }
      if(irrelevant.length){
        const keys=new Set(irrelevant.map(item=>item.key));
        state.pending_actionable_events=state.pending_actionable_events.filter(item=>!keys.has(item.key));save();
      }
      if(!relevant.length){retryDelay=1000;return}
      const code=await runHermes(relevant);
      if(code!==0)throw new Error(`Hermes exited with code ${code}`);
      const completed=new Set(relevant.map(item=>item.key));
      state.pending_actionable_events=state.pending_actionable_events.filter(item=>!completed.has(item.key));
      retryDelay=1000;save();
    }catch(error){
      fs.appendFileSync(logFile,`\nbridge wake failed; durable actionable events retained for retry: ${error.message}\n`);
      state.last_wake_error=String(error.message??error);save();
      retryDelay=Math.min(retryDelay*2,30000);
    }finally{
      hermesBusy=false;
      if(state.pending_actionable_events.length)scheduleWake(retryDelay);
    }
  };
  await ensureSession();
  while(!stopping){
    try{
      const wsBase=config.MULTIPLAYER_BASE_URL.replace(/^http:/,'ws:').replace(/^https:/,'wss:');
      const cursor=state.last_contiguous_seq;
      const url=`${wsBase}${sessionRoute('/stream')}${cursor===null?'':`?after_seq=${cursor}`}`;
      socket=new WebSocket(url,{headers:{authorization:`Bearer ${state.session_token}`}});
      await new Promise((resolve,reject)=>{
        socket.once('open',()=>{state.connection='live';save();resolve()});socket.once('error',reject);
      });
      scheduleWake(0);
      const heartbeat=setInterval(()=>sessionHttp('POST','/heartbeat',{runtime_status:hermesBusy?'working':'idle'}).catch(()=>{}),20000);
      await new Promise((resolve,reject)=>{
        socket.on('message',raw=>{
          try{
            const frame=JSON.parse(raw.toString());
            if(frame.type==='room.snapshot'){
              const snapshotSeq=Number(frame.snapshot_seq);
              state.last_contiguous_seq=snapshotSeq;state.processed_event_ids=[];
              rememberActionable({key:`room.snapshot:${snapshotSeq}`,type:'room.snapshot',snapshot_seq:snapshotSeq});
              scheduleWake();return;
            }
            if(frame.type==='room.event'){
              const seq=Number(frame.event.room_seq),last=Number(state.last_contiguous_seq??0);
              if(seq<=last)return;
              if(seq!==last+1){state.connection='gap';save();socket.close();return}
              state.last_contiguous_seq=seq;
              state.processed_event_ids=[...state.processed_event_ids,eventKey(frame.event)].slice(-500);
              if(isActionableCandidate(frame.event))rememberActionable({key:eventKey(frame.event),type:'room.event',event:frame.event});
              else save();
              socket.send(JSON.stringify({type:'ack',room_seq:seq}));
              scheduleWake();
              return;
            }
            if(frame.type==='resync_required'){state.last_contiguous_seq=null;state.connection='resync_required';save();socket.close();return}
            if(frame.type==='access_revoked'){state.connection='access_revoked';save();reject(new Error('Gateway access revoked'));return}
            if(frame.type==='protocol_error'){reject(new Error(`Gateway protocol error: ${frame.code}`))}
          }catch(error){reject(error)}
        });
        socket.once('close',resolve);socket.once('error',reject);
      });
      clearInterval(heartbeat);
    }catch(error){
      state.connection='reconnecting';state.last_error=String(error.message??error);save();
      if(String(error.message??error).includes('revoked'))throw error;
    }
    if(!stopping)await sleep(1500);
  }
}

action().catch(error=>die(error.stack??String(error)));
