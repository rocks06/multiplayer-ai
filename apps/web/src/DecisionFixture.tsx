import {useState} from 'react';
import {DecisionCard} from './App';
import type {Decision,Member} from './types';

/**
 * Hand-written decisions for reviewing cases a live room cannot be asked to produce on demand:
 * several at once, from different agents, and one long enough to test the layout's limits.
 * This route reads no live room data and resolves nothing — the handler only records the call.
 */
const COLEMAN='00000000-0000-4000-8000-0000000000c1';
const JJ='00000000-0000-4000-8000-0000000000c2';
const minutesAgo=(n:number)=>new Date(Date.now()-n*60_000).toISOString();

const coleman:Member={principal_id:COLEMAN,display_name:'Coleman',kind:'agent',role:'worker_agent',responsibilities:''};
const jj:Member={principal_id:JJ,display_name:'JJ',kind:'agent',role:'worker_agent',responsibilities:''};

const decision=(o:Partial<Decision>&{id:string}):Decision=>({
  run_id:null,requested_by_principal_id:COLEMAN,title:'Publish the 429 contract now?',
  question:'Should we publish the quota contract before the proxy is corrected?',
  rationale:'Publishing first unblocks the launch date.',
  proposed_action:{action:'publish_quota_contract',status_code:429},
  proposed_action_digest:'1f71a252a69d'.padEnd(64,'0'),status:'pending',version:1,
  resolved_by_principal_id:null,resolution_note:null,requested_at:minutesAgo(3),resolved_at:null,expires_at:null,
  ...o});

const longQuestion='Should we publish the quota contract with a documented Retry-After header that the gateway computes from the per-region connection budget, knowing that the upstream proxy closes bursting sockets before our middleware observes them, so the documented value will be approximately correct for single-tenant traffic and materially wrong whenever a region is saturated by another customer?';
const longAction={action:'publish_quota_contract',status_code:429,includes_retry_after:true,defer_proxy_fix:true,affected_endpoints:['/v1/events','/v1/projections','/v1/players/search','/v1/games/{id}/odds','/v1/games/{id}/props'],caveats:['per-region limit','retry-after approximate under saturation','proxy fix owned by platform team']};

const cases:Array<{name:string;decisions:Decision[];requester:(d:Decision)=>Member}>=[
  {name:'One pending decision',decisions:[decision({id:'f1'})],requester:()=>coleman},
  {name:'Several, from different agents',decisions:[
    decision({id:'f2',requested_by_principal_id:COLEMAN,title:'Publish the 429 contract now?',requested_at:minutesAgo(9)}),
    decision({id:'f3',requested_by_principal_id:JJ,title:'Drop the Retry-After header from the published contract?',requested_at:minutesAgo(4)}),
    decision({id:'f4',requested_by_principal_id:JJ,title:'Ship the docs PR without the platform team review?',requested_at:minutesAgo(1)}),
  ],requester:d=>d.requested_by_principal_id===JJ?jj:coleman},
  {name:'Long question and action',decisions:[decision({id:'f5',title:'Publish a computed Retry-After the proxy can invalidate?',question:longQuestion,proposed_action:longAction,rationale:'The launch date depends on publishing something, and an approximate header is more useful to callers than none — but only if the caveat is documented alongside it.'})],requester:()=>coleman},
];

export default function DecisionFixture(){
  const [resolved,setResolved]=useState<string[]>([]);
  return <main className="fixture-page">
    <p className="fixture-note">Fixture — hand-written decisions for visual review. This page reads no live room data and resolves nothing.</p>
    <div className="fixture-grid">
      {cases.map(entry=>
        <section className="fixture-card" key={entry.name}>
          <h3>{entry.name}</h3>
          <div className="needs-you">
            {entry.decisions.map(d=>
              <DecisionCard key={d.id} decision={d} requester={entry.requester(d)}
                onResolve={async(result)=>{setResolved(prior=>[...prior,`${d.id}:${result}`])}}/>)}
          </div>
        </section>)}
      <section className="fixture-card">
        <h3>Resolved on this page</h3>
        <p style={{margin:0,fontSize:12,color:'var(--muted)'}}>{resolved.length?resolved.join(', '):'Nothing resolved yet. Approving or rejecting here records the call and changes no room.'}</p>
      </section>
    </div>
  </main>;
}
