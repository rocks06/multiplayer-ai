#!/usr/bin/env node
// Thin CLI over the connector core. Protocol behaviour lives in packages/connector-core and
// the Hermes specifics in packages/connector-hermes; this file is argument parsing, local
// file layout, and process lifecycle only.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

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

const cli=args(process.argv.slice(2));
const command=cli._[0]??'help';
const envInput=String(cli.env??process.env.MULTIPLAYER_ENV_FILE??'');
if(command!=='help'&&!envInput)die('Use --env /absolute/path/to/<agent>.env');
const envFile=envInput?path.resolve(envInput):'';
const config=command==='help'?{}:{...loadEnv(envFile),...process.env};
const required=['MULTIPLAYER_BASE_URL','MULTIPLAYER_ROOM_ID','MULTIPLAYER_PROFILE','MULTIPLAYER_AGENT_PRINCIPAL_ID','MULTIPLAYER_CREDENTIAL'];
if(command!=='help')for(const key of required)if(!config[key])die(`Missing ${key} in ${envFile}`);
const home=path.dirname(path.dirname(envFile));
const runtimeDir=path.join(home,'runtime');
const stateFile=path.join(runtimeDir,`${config.MULTIPLAYER_PROFILE}.state.json`);
const pidFile=path.join(runtimeDir,`${config.MULTIPLAYER_PROFILE}.pid`);
const logFile=path.join(runtimeDir,`${config.MULTIPLAYER_PROFILE}.log`);
const bridgeFile=path.resolve(process.argv[1]);

const VERBS=['snapshot','tasks','task --id ID','message --body TEXT [--to ID] [--task ID] --key KEY','task-status --id ID --status STATUS --version N --key KEY','task-complete --id ID --version N --key KEY','decision-request --title TEXT --question TEXT --rationale TEXT --proposed-action-json JSON --key KEY','decision-get --id ID'];

async function loadModule(kind,envOverride,packageName){
  const candidates=[
    process.env[envOverride],
    path.join(path.dirname(bridgeFile),'core',packageName,'src','index.js'),
    path.resolve(path.dirname(bridgeFile),`../../dist/packages/${packageName}/src/index.js`),
  ].filter(Boolean);
  for(const candidate of candidates)if(fs.existsSync(candidate))return import(pathToFileURL(candidate).href);
  die(`${kind} build not found. Run "pnpm build:server" in the repository, or set ${envOverride}.`);
}
const loadCore=()=>loadModule('Connector core','MULTIPLAYER_CONNECTOR_CORE','connector-core');
const loadHermes=()=>loadModule('Hermes adapter','MULTIPLAYER_CONNECTOR_HERMES','connector-hermes');

const gatewayConfig=()=>({
  baseUrl:config.MULTIPLAYER_BASE_URL,
  roomId:config.MULTIPLAYER_ROOM_ID,
  agentPrincipalId:config.MULTIPLAYER_AGENT_PRINCIPAL_ID,
  credential:config.MULTIPLAYER_CREDENTIAL,
  httpTimeoutMs:Number(config.MULTIPLAYER_HTTP_TIMEOUT_MS??15000),
});

function need(name){const value=cli[name];if(value===undefined||value===true)die(`--${name} is required`);return String(value)}
const numeric=name=>{const value=Number(need(name));if(!Number.isInteger(value)||value<0)die(`--${name} must be a non-negative integer`);return value};

/** A client bound to the session already on disk, for one-shot agent commands. */
async function boundClient(core){
  const store=new core.FileStateStore(stateFile);
  const state=store.load();
  const client=new core.GatewayClient(gatewayConfig(),session=>{
    const current=store.load();
    store.save({...current,session_id:session.sessionId,session_token:session.sessionToken,room_id:config.MULTIPLAYER_ROOM_ID,agent_principal_id:config.MULTIPLAYER_AGENT_PRINCIPAL_ID});
  });
  if(state.session_id&&state.session_token)client.adoptSession({sessionId:state.session_id,sessionToken:state.session_token});
  await client.ensureSession();
  return client;
}

async function statusReport(core){
  const state=new core.FileStateStore(stateFile).load();
  const pid=fs.existsSync(pidFile)?Number(fs.readFileSync(pidFile,'utf8')):null;
  const running=pid!==null&&(()=>{try{process.kill(pid,0);return true}catch{return false}})();
  // state.connection is only this connector's last local claim. A killed, crashed, slept, or
  // network-isolated daemon leaves it reading 'live' forever, so never report it as live
  // unless the daemon process actually exists.
  const report={profile:config.MULTIPLAYER_PROFILE,room_id:config.MULTIPLAYER_ROOM_ID,agent_principal_id:config.MULTIPLAYER_AGENT_PRINCIPAL_ID,session_id:state.session_id??null,pid,process_running:running,connection:running?(state.connection??'not_started'):'not_running',last_contiguous_seq:state.last_contiguous_seq??null,pending_actionable_events:state.pending_actionable_events.length};
  if(cli.verify){
    const client=new core.GatewayClient(gatewayConfig());
    try{
      const rooms=await client.listRooms();
      const room=rooms.rooms.find(item=>item.id===config.MULTIPLAYER_ROOM_ID);
      report.room_authorized=Boolean(room);
      report.room_last_event_seq=room?Number(room.last_event_seq):null;
    }catch(error){report.room_authorized=false;report.verify_error=String(error.message??error)}
    // Whether this process is running and whether the Gateway holds a connected session are
    // independent facts. Ask about the existing session without opening a new one.
    if(state.session_id&&state.session_token){
      try{
        const session=await client.http('GET',`/v1/agent-gateway/v1/sessions/${state.session_id}`,undefined,state.session_token);
        report.gateway_session_status=session.status;
        report.gateway_runtime_status=session.runtime_status;
        report.gateway_last_ack_room_seq=Number(session.last_ack_room_seq);
        report.gateway_last_seen_at=session.last_seen_at;
        if(Number.isFinite(Number(session.room_last_event_seq)))report.room_last_event_seq=Number(session.room_last_event_seq);
      }catch(error){report.gateway_session_status='unreachable';report.session_verify_error=String(error.message??error)}
    }else report.gateway_session_status='none';
    report.behind_by=report.room_last_event_seq!==null&&report.room_last_event_seq!==undefined&&report.last_contiguous_seq!==null?Math.max(0,report.room_last_event_seq-report.last_contiguous_seq):null;
  }
  return report;
}

async function runDaemon(core,hermes){
  fs.mkdirSync(runtimeDir,{recursive:true,mode:0o700});
  if(fs.existsSync(pidFile)){
    const old=Number(fs.readFileSync(pidFile,'utf8'));
    try{process.kill(old,0);die(`Bridge already running with PID ${old}`)}catch{}
  }
  fs.writeFileSync(pidFile,String(process.pid)+'\n',{mode:0o600});

  const runtime=new core.ConnectorRuntime({
    config:gatewayConfig(),
    profile:config.MULTIPLAYER_PROFILE,
    store:new core.FileStateStore(stateFile),
    adapter:new hermes.HermesAdapter({command:config.HERMES_COMMAND}),
    commandSurface:{template:`node ${JSON.stringify(bridgeFile)} COMMAND --env ${JSON.stringify(envFile)}`,verbs:VERBS},
    logPath:logFile,
    stream:{
      reconnectBaseMs:Number(config.MULTIPLAYER_RECONNECT_BASE_MS??1000),
      reconnectMaxMs:Number(config.MULTIPLAYER_RECONNECT_MAX_MS??30000),
      pingIntervalMs:Number(config.MULTIPLAYER_WS_PING_MS??20000),
    },
  });

  const cleanup=()=>{runtime.stop();try{fs.unlinkSync(pidFile)}catch{}};
  process.on('SIGTERM',()=>{cleanup();process.exit(0)});
  process.on('SIGINT',()=>{cleanup();process.exit(0)});
  await runtime.start();
}

async function action(){
  if(command==='help')return console.log(`Usage: node bridge.mjs <command> --env FILE [options]\n\nDaemon: run | status [--verify] | stop\nAgent actions: ${VERBS.join(' | ')} | heartbeat --runtime-status idle|working`);
  if(command==='check')return json({valid:true,profile:config.MULTIPLAYER_PROFILE,base_url:config.MULTIPLAYER_BASE_URL,room_id:config.MULTIPLAYER_ROOM_ID,agent_principal_id:config.MULTIPLAYER_AGENT_PRINCIPAL_ID,credential_present:true,credential_value_exposed:false});
  if(command==='stop'){
    if(!fs.existsSync(pidFile))return json({stopped:false,reason:'not_running'});
    const pid=Number(fs.readFileSync(pidFile,'utf8'));
    try{process.kill(pid,'SIGTERM');return json({stopped:true,pid})}catch{return json({stopped:false,reason:'stale_pid',pid})}
  }

  const core=await loadCore();
  if(command==='status')return json(await statusReport(core));
  if(command==='run')return runDaemon(core,await loadHermes());

  const client=await boundClient(core);
  if(command==='snapshot')return json(await client.snapshot());
  if(command==='tasks')return json(await client.tasks());
  if(command==='task')return json(await client.task(need('id')));
  if(command==='message')return json(await client.sendMessage({body:need('body'),addressedPrincipalId:cli.to?String(cli.to):undefined,taskId:cli.task?String(cli.task):undefined},need('key')));
  if(command==='task-status')return json(await client.updateTaskStatus(need('id'),need('status'),numeric('version'),need('key')));
  if(command==='task-complete')return json(await client.completeTask(need('id'),numeric('version'),need('key')));
  if(command==='decision-request'){
    let proposed;try{proposed=JSON.parse(need('proposed-action-json'))}catch{die('--proposed-action-json must be valid JSON')}
    return json(await client.requestDecision({title:need('title'),question:need('question'),rationale:String(cli.rationale??''),proposedAction:proposed},need('key')));
  }
  if(command==='decision-get')return json(await client.decision(need('id')));
  if(command==='heartbeat')return json(await client.heartbeat(need('runtime-status')));
  die(`Unknown command: ${command}`);
}

action().catch(error=>die(error.stack??String(error)));
