import {describe,it,expect,vi} from 'vitest';
import {WebSocketServer} from 'ws';
import {EventStream} from '../packages/connector-core/src/event-stream.js';
import {ConnectorRuntime,MemoryStateStore} from '../packages/connector-core/src/index.js';

const waitUntil=async(test:()=>boolean)=>{const end=Date.now()+2000;while(!test()){if(Date.now()>end)throw Error('condition not reached');await new Promise(r=>setTimeout(r,5))}};
describe('authenticated readiness and invocation cleanup',()=>{
 it('does not claim Connected on socket open; waits for session.ready',async()=>{
  const server=new WebSocketServer({port:0});await new Promise<void>(r=>server.once('listening',r));
  const port=(server.address() as {port:number}).port;
  const states:string[]=[];let socket:any;
  server.on('connection',s=>{socket=s});
  const stream=new EventStream({ensureSession:async()=>{},route:()=>'/stream',sessionToken:'synthetic-test-token',heartbeat:async()=>{}} as any,{
   cursor:()=>null,onConnectionState:s=>states.push(s),onConnected:()=>{},onError:()=>{},onEvent:()=> 'applied',onSnapshot:()=>{},onResync:()=>{},runtimeStatus:()=> 'idle',
  },{baseUrl:`http://127.0.0.1:${port}`});
  const running=stream.run();
  try{await waitUntil(()=>!!socket);expect(states).not.toContain('live');
   socket.send(JSON.stringify({type:'session.ready'}));await waitUntil(()=>states.includes('live'));
  }finally{stream.stop();await running;await new Promise<void>(r=>server.close(()=>r()))}
 });
 for(const failure of ['assignedWork','invoke'])it(`clears Working and sends Idle when ${failure} fails`,async()=>{
  const invoke=vi.fn(async()=>{if(failure==='invoke')throw Error('synthetic execution failure');return {exitCode:0}});
  const runtime=new ConnectorRuntime({config:{baseUrl:'http://invalid.test',roomId:'room',agentPrincipalId:'agent',credential:'test'},profile:'test',store:new MemoryStateStore(),adapter:{invoke} as any,commandSurface:{template:'test',verbs:[]},logPath:'/dev/null'});
  const heartbeat=vi.fn(async()=>{});
  (runtime as any).client.assignedWork=async()=>{if(failure==='assignedWork')throw Error('synthetic lookup failure');return []};
  (runtime as any).client.heartbeat=heartbeat;
  await (runtime as any).invoke([]).catch(()=>{});
  expect(runtime.snapshotState.hermes_running).toBe(false);
  expect(heartbeat).toHaveBeenLastCalledWith('idle');
  runtime.stop();
 });
});
