/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import RoomApp from '../apps/web/src/App';
import type {RoomSnapshot} from '../apps/web/src/types';

const company='00000000-0000-4000-8000-000000000001',room='00000000-0000-4000-8000-000000000002',alex='00000000-0000-4000-8000-000000000003',agent='00000000-0000-4000-8000-000000000004';
const snapshot:RoomSnapshot={
 room:{id:room,name:'Launch room',last_event_seq:8,project_id:'p',project_name:'Northstar',objective:'Prepare a precise product launch'},snapshot_seq:8,
 members:[{principal_id:alex,display_name:'Alex',kind:'human',role:'manager',responsibilities:'Own the launch'},{principal_id:agent,display_name:"Alex's Agent",kind:'agent',role:'worker_agent',responsibilities:'Research and synthesis',agent_presence:'connected',agent_connection:'connected',agent_runtime_status:'working',agent_last_seen_at:new Date().toISOString()}],
 tasks:[{id:'task',title:'Verify launch claims',description:'Check source material',status:'in_progress',assignee_principal_id:agent,version:2,updated_at:new Date().toISOString()}],
 messages:[{id:'message',sender_principal_id:agent,addressed_principal_id:alex,body_text:'The source review is complete.',task_id:'task',created_at:new Date().toISOString(),sender_name:"Alex's Agent",sender_kind:'agent'}],
 briefing:{briefing_seq:8,project_objective:'Prepare a precise product launch',participants:[],joining_principal:{principal_id:alex,role:'manager',responsibilities:'Own the launch'},active_tasks:[],relevant_completed_work:[],blockers:[],relevant_artifacts:[],important_recent_activity:[],unresolved_decisions:[{id:'decision',run_id:'run',requested_by_principal_id:agent,title:'Approve release',question:'May I publish the verified launch note?',rationale:'Publishing requires human authority',proposed_action:{type:'publish',target:'launch-note'},proposed_action_digest:'a'.repeat(64),status:'pending',version:1,resolved_by_principal_id:null,resolution_note:null,requested_at:new Date().toISOString(),resolved_at:null,expires_at:null}]}
};
const identity={user:{id:'00000000-0000-4000-8000-00000000000f',email:'alex@example.com',display_name:'Alex'},companies:[{company_id:company,company_name:'Acme',principal_id:alex,display_name:'Alex'}]};
class FakeSocket{
 static OPEN=1;static instances:FakeSocket[]=[];readyState=1;onmessage:((e:{data:string})=>void)|null=null;onclose:(()=>void)|null=null;onerror:(()=>void)|null=null;
 constructor(){FakeSocket.instances.push(this);queueMicrotask(()=>this.emit({type:'resumed',after_seq:8,latest_seq:8}))}
 emit(frame:unknown){this.onmessage?.({data:JSON.stringify(frame)})}
 send(){}close(){this.readyState=3;this.onclose?.()}
}

describe('Slice 6 room interface',()=>{
 beforeEach(()=>{
  history.replaceState({},'',`/rooms/${company}/${room}`);
  FakeSocket.instances=[];
  vi.stubGlobal('WebSocket',FakeSocket);
  vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
   if(String(url).includes('/v1/auth/me'))return new Response(JSON.stringify(identity),{status:200,headers:{'content-type':'application/json'}});
   if(init?.method==='POST')return new Response(JSON.stringify({ok:true}),{status:200,headers:{'content-type':'application/json'}});
   return new Response(JSON.stringify(snapshot),{status:200,headers:{'content-type':'application/json'}});
  }));
 });
 afterEach(()=>{cleanup();vi.unstubAllGlobals()});
 it('renders room context, distinct identities, active work, and a priority decision',async()=>{
  render(<RoomApp/>);
  expect(await screen.findByRole('heading',{name:'Launch room'})).toBeVisible();
  expect(screen.getByText('Alex',{selector:'strong'})).toBeVisible();
  expect(screen.getAllByText("Alex's Agent").length).toBeGreaterThan(0);
  expect(screen.getByText(/Working/,{selector:'small'})).toBeVisible();
  expect(screen.queryByText(/Not connected/)).toBeNull();
  expect(screen.getByTestId('decision-card')).toHaveTextContent('May I publish the verified launch note?');
  expect(screen.getByRole('button',{name:'Approve'})).toBeEnabled();
  expect(screen.getByText('The source review is complete.')).toBeVisible();
 });
 it('reports agent presence from durable Gateway state rather than inferring it',async()=>{
  // A task can be in progress while the runtime that owns it has vanished. The room must say
  // so instead of reporting the agent as working, which is the blind spot found in physical
  // testing when a connector had been gone for minutes and still read as live.
  const cases:Array<[any,RegExp]>=[
   [{agent_presence:'never'},/Not connected/],
   [{agent_presence:'offline',agent_last_seen_at:new Date().toISOString()},/Offline/],
   [{agent_presence:'stale',agent_last_seen_at:new Date().toISOString()},/Unresponsive/],
   [{agent_presence:'revoked',agent_last_seen_at:new Date().toISOString()},/Access revoked/],
   [{agent_presence:'connected',agent_runtime_status:'idle',agent_last_seen_at:new Date().toISOString()},/Connected . idle/],
  ];
  for(const [presence,expected] of cases){
   cleanup();
   const variant={...snapshot,members:[snapshot.members[0]!,{...snapshot.members[1]!,agent_runtime_status:null,...presence}]};
   vi.stubGlobal('fetch',vi.fn(async(url:string)=>String(url).includes('/v1/auth/me')
    ?new Response(JSON.stringify(identity),{status:200,headers:{'content-type':'application/json'}})
    :new Response(JSON.stringify(variant),{status:200,headers:{'content-type':'application/json'}})));
   render(<RoomApp/>);
   await screen.findByRole('heading',{name:'Launch room'});
   expect(screen.getByText(expected,{selector:'small'})).toBeVisible();
   expect(screen.queryByText(/^Working$/,{selector:'small'})).toBeNull();
  }
 });

 it('shows waiting on a peer only from a real dependency',async()=>{
  // The agent is connected and idle, but its task is blocked by work owned by someone else.
  // That is a modelled dependency, never an inference from an unanswered message.
  const blocked={...snapshot,
   members:[{...snapshot.members[0]!},{...snapshot.members[1]!,agent_runtime_status:'idle' as const}],
   tasks:[{...snapshot.tasks[0]!,blocked_by:[{task_id:'blocker',title:'Investigate constraints',status:'in_progress' as const,assignee_principal_id:alex}]}]};
  vi.mocked(fetch).mockImplementation(async(url:any)=>String(url).includes('/v1/auth/me')
   ?new Response(JSON.stringify(identity),{status:200,headers:{'content-type':'application/json'}})
   :new Response(JSON.stringify(blocked),{status:200,headers:{'content-type':'application/json'}}));
  render(<RoomApp/>);
  await screen.findByRole('heading',{name:'Launch room'});
  expect(screen.getByText(/Waiting on Alex/,{selector:'small'})).toBeVisible();
  expect(screen.queryByText(/Connected . idle/,{selector:'small'})).toBeNull();
 });

 it('sends an addressed message and clears the composer after authoritative success',async()=>{
  render(<RoomApp/>);await screen.findByRole('heading',{name:'Launch room'});
  fireEvent.change(screen.getByLabelText('Send to'),{target:{value:agent}});
  fireEvent.change(screen.getByLabelText('Message'),{target:{value:'Check the final citations.'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Send message'})));
  await waitFor(()=>expect(screen.getByLabelText('Message')).toHaveValue(''));
  const calls=vi.mocked(fetch).mock.calls;
  expect(calls.some(([,init])=>init?.method==='POST'&&String(init.body).includes('Check the final citations.'))).toBe(true);
 });
 it('creates command keys when randomUUID is unavailable on an insecure LAN origin',async()=>{
  vi.stubGlobal('crypto',{getRandomValues:(bytes:Uint8Array)=>{bytes.fill(7);return bytes}});
  render(<RoomApp/>);await screen.findByRole('heading',{name:'Launch room'});
  fireEvent.change(screen.getByLabelText('Message'),{target:{value:'LAN-safe message'}});
  await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Send message'})));
  await waitFor(()=>expect(screen.getByLabelText('Message')).toHaveValue(''));
  expect(vi.mocked(fetch).mock.calls.some(([,init])=>new Headers(init?.headers).get('idempotency-key')==='07070707-0707-4707-8707-070707070707')).toBe(true);
 });
 it('prevents contributors from resolving decisions',async()=>{
  const contributor={...snapshot,members:snapshot.members.map(member=>member.principal_id===alex?{...member,role:'contributor' as const}:member),briefing:{...snapshot.briefing,joining_principal:{...snapshot.briefing.joining_principal,role:'contributor' as const}}};
  vi.mocked(fetch).mockImplementation(async(url:any)=>String(url).includes('/v1/auth/me')
   ?new Response(JSON.stringify(identity),{status:200,headers:{'content-type':'application/json'}})
   :new Response(JSON.stringify(contributor),{status:200,headers:{'content-type':'application/json'}}));
  render(<RoomApp/>);
  expect(await screen.findByText('A room manager can resolve this decision.')).toBeVisible();
  expect(screen.queryByRole('button',{name:'Approve'})).not.toBeInTheDocument();
 });
 it('takes a fresh snapshot and reconnects when realtime requires resynchronization',async()=>{
  render(<RoomApp/>);await screen.findByRole('heading',{name:'Launch room'});
  expect(FakeSocket.instances).toHaveLength(1);
  act(()=>FakeSocket.instances[0]!.emit({type:'resync_required',reason:'gap',latest_seq:12}));
  await waitFor(()=>expect(vi.mocked(fetch).mock.calls.length).toBeGreaterThanOrEqual(2));
  await waitFor(()=>expect(FakeSocket.instances).toHaveLength(2));
  expect(await screen.findByRole('status')).toHaveTextContent('Live');
 });
});
