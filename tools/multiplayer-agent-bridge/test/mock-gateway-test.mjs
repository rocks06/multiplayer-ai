import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {WebSocketServer} from 'ws';

const bridge=fileURLToPath(new URL('../bridge.mjs',import.meta.url));
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mp-bridge-test-'));
const identities=path.join(root,'identities');fs.mkdirSync(identities,{recursive:true});
const room='00000000-0000-4000-8000-000000000001';
const principal='00000000-0000-4000-8000-000000000002';
const peer='00000000-0000-4000-8000-000000000003';
const session='00000000-0000-4000-8000-000000000004';
let ack=null;
const server=http.createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 res.setHeader('content-type','application/json');
 if(req.url==='/v1/agent-gateway/v1/rooms')return res.end(JSON.stringify({agent_principal_id:principal,rooms:[{id:room,last_event_seq:6}]}));
 if(req.url==='/v1/agent-gateway/v1/sessions'&&req.method==='POST')return res.end(JSON.stringify({session_id:session,session_token:'mags_mock',room_id:room,agent_principal_id:principal}));
 if(req.url?.endsWith('/heartbeat'))return res.end(JSON.stringify({status:'connected'}));
 res.statusCode=404;res.end(JSON.stringify({error:{code:'not_found'}}));
});
const wss=new WebSocketServer({noServer:true});
server.on('upgrade',(req,socket,head)=>wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req)));
wss.on('connection',ws=>{
 ws.on('message',raw=>{const frame=JSON.parse(raw.toString());if(frame.type==='ack')ack=frame.room_seq});
 ws.send(JSON.stringify({type:'session.ready',protocol:'agent-gateway.v1',session_id:session,room_id:room,agent_principal_id:principal,latest_seq:6}));
 ws.send(JSON.stringify({type:'room.snapshot',room_id:room,snapshot_seq:5,snapshot:{}}));
 setTimeout(()=>ws.send(JSON.stringify({type:'room.event',room_id:room,event:{id:'event-6',room_seq:6,event_type:'message.sent',actor_principal_id:peer,payload:{body:'mock'}}})),50);
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const env=path.join(identities,'mock.env');
fs.writeFileSync(env,[`MULTIPLAYER_BASE_URL=http://127.0.0.1:${port}`,`MULTIPLAYER_ROOM_ID=${room}`,'MULTIPLAYER_PROFILE=mock',`MULTIPLAYER_AGENT_PRINCIPAL_ID=${principal}`,`MULTIPLAYER_PEER_PRINCIPAL_ID=${peer}`,'MULTIPLAYER_CREDENTIAL=magc_mock','MULTIPLAYER_TASK_ID=00000000-0000-4000-8000-000000000005','HERMES_COMMAND=/usr/bin/true'].join('\n')+'\n',{mode:0o600});
const child=spawn('node',[bridge,'run','--env',env],{stdio:'ignore'});
let state;
for(let i=0;i<100;i++){
 await new Promise(resolve=>setTimeout(resolve,50));
 const file=path.join(root,'runtime','mock.state.json');
 if(fs.existsSync(file)){state=JSON.parse(fs.readFileSync(file,'utf8'));if(state.last_contiguous_seq===6&&ack===6)break}
}
child.kill('SIGTERM');await new Promise(resolve=>child.once('exit',resolve));
const wssClosed=()=>{wss.close();server.close()};
if(state?.last_contiguous_seq!==6||ack!==6)throw new Error(`Expected cursor/ack 6, got state=${JSON.stringify(state)} ack=${ack}`);

// A daemon that was hard-killed, slept, or fell off the network leaves state.connection reading
// 'live' and a stale pid file behind. status must report the process is gone rather than repeat
// that stale local claim, and --verify must expose the durable room cursor.
const stateFile=path.join(root,'runtime','mock.state.json');
const pidFile=path.join(root,'runtime','mock.pid');
const dead=spawn(process.execPath,['-e','']);
await new Promise(resolve=>dead.once('exit',resolve));
fs.writeFileSync(stateFile,JSON.stringify({...state,connection:'live'},null,2)+'\n',{mode:0o600});
fs.writeFileSync(pidFile,String(dead.pid)+'\n',{mode:0o600});
const runStatus=extra=>new Promise((resolve,reject)=>{
 const proc=spawn(process.execPath,[bridge,'status','--env',env,...extra],{stdio:['ignore','pipe','inherit']});
 let out='';proc.stdout.on('data',chunk=>{out+=chunk});
 proc.once('exit',code=>code===0?resolve(JSON.parse(out)):reject(new Error(`status exited ${code}`)));
});
const stale=await runStatus([]);
if(stale.process_running!==false||stale.connection!=='not_running')throw new Error(`Stale status reported ${JSON.stringify(stale)}`);
const verified=await runStatus(['--verify']);
if(verified.room_authorized!==true||verified.room_last_event_seq!==6||verified.behind_by!==0)throw new Error(`Verified status reported ${JSON.stringify(verified)}`);
wssClosed();
console.log(JSON.stringify({mock_gateway_passed:true,session_created:true,snapshot_seq:5,applied_event_seq:6,ack_seq:ack,hermes_replaced_with:'/usr/bin/true',stale_pid_reported_as:stale.connection,verified_behind_by:verified.behind_by,real_room_touched:false}));
fs.rmSync(root,{recursive:true,force:true});
