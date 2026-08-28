import {Participants} from './App';
import type {Decision,Member,Task} from './types';

/**
 * A deterministic gallery of every presence state, for reviewing states that a real connector
 * cannot be made to produce on demand — a revoked credential, a session that has gone silent,
 * an agent stopped on a decision.
 *
 * This route reads no live data and writes none. Everything below is written by hand, which is
 * why the banner says so on screen: a fixture must never be mistaken for the room.
 */
const AGENT='00000000-0000-4000-8000-0000000000a1';
const PEER='00000000-0000-4000-8000-0000000000a2';
const TASK='00000000-0000-4000-8000-0000000000b1';
const BLOCKER='00000000-0000-4000-8000-0000000000b2';
const minutesAgo=(n:number)=>new Date(Date.now()-n*60_000).toISOString();

const peer:Member={principal_id:PEER,display_name:'Agent A',kind:'agent',role:'worker_agent',responsibilities:'Research'};
const agent=(overrides:Partial<Member>):Member=>({principal_id:AGENT,display_name:'Agent B',kind:'agent',role:'worker_agent',responsibilities:'Integration',...overrides});

const task=(overrides:Partial<Task>):Task=>({id:TASK,title:'Design the published quota contract',description:'',status:'in_progress',assignee_principal_id:AGENT,version:2,updated_at:minutesAgo(4),...overrides});
const blockedTask=task({status:'open',blocked_by:[{task_id:BLOCKER,title:'Investigate rate-limit behaviour',status:'in_progress',assignee_principal_id:PEER}]});
const decision:Decision={id:'d1',run_id:null,requested_by_principal_id:AGENT,title:'Publish the 429 contract now?',question:'',rationale:'',proposed_action:{},proposed_action_digest:'a'.repeat(64),status:'pending',version:1,resolved_by_principal_id:null,resolution_note:null,requested_at:minutesAgo(2),resolved_at:null,expires_at:null};

const cases:Array<{name:string;member:Member;tasks:Task[];decisions:Decision[]}>=[
  {name:'Working',member:agent({agent_presence:'connected',agent_runtime_status:'working',agent_last_seen_at:minutesAgo(0)}),tasks:[task({})],decisions:[]},
  {name:'Idle',member:agent({agent_presence:'connected',agent_runtime_status:'idle',agent_last_seen_at:minutesAgo(0)}),tasks:[],decisions:[]},
  {name:'Waiting on another agent',member:agent({agent_presence:'connected',agent_runtime_status:'idle',agent_last_seen_at:minutesAgo(0)}),tasks:[blockedTask],decisions:[]},
  {name:'Waiting for a human decision',member:agent({agent_presence:'connected',agent_runtime_status:'idle',agent_last_seen_at:minutesAgo(0)}),tasks:[task({status:'awaiting_decision'})],decisions:[decision]},
  {name:'Unresponsive',member:agent({agent_presence:'stale',agent_runtime_status:'working',agent_last_seen_at:minutesAgo(3)}),tasks:[task({})],decisions:[]},
  {name:'Offline',member:agent({agent_presence:'offline',agent_runtime_status:'idle',agent_last_seen_at:minutesAgo(47)}),tasks:[],decisions:[]},
  {name:'Access revoked',member:agent({agent_presence:'revoked',agent_last_seen_at:minutesAgo(180)}),tasks:[],decisions:[]},
  {name:'Never connected',member:agent({agent_presence:'never'}),tasks:[],decisions:[]},
  {name:'Long name, mixed state',member:agent({display_name:'Agent A Rate-Limit And Quota Investigation Agent',agent_presence:'connected',agent_runtime_status:'working',agent_last_seen_at:minutesAgo(0)}),tasks:[task({title:'Investigate rate-limit behaviour under sustained burst load across every published developer endpoint'})],decisions:[]},
];

export default function PresenceFixture(){
  return <main className="fixture-page">
    <p className="fixture-note">Fixture — hand-written states for visual review. This page reads no live room data.</p>
    <div className="fixture-grid">
      {cases.map(entry=>
        <section className="fixture-card" key={entry.name}>
          <h3>{entry.name}</h3>
          <Participants members={[entry.member,peer]} currentId="none" tasks={entry.tasks} decisions={entry.decisions}/>
        </section>)}
    </div>
  </main>;
}
