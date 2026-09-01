import {describe,expect,it} from 'vitest';
import {describePresence,elapsedLabel} from '../apps/web/src/presence';
import type {Decision,Member,Task} from '../apps/web/src/types';

const AGENT='00000000-0000-4000-8000-0000000000a1';
const PEER='00000000-0000-4000-8000-0000000000a2';

const agent=(o:Partial<Member>={}):Member=>({principal_id:AGENT,display_name:'Agent B',kind:'agent',role:'worker_agent',responsibilities:'',...o});
const peer:Member={principal_id:PEER,display_name:'Agent A',kind:'agent',role:'worker_agent',responsibilities:''};
const task=(o:Partial<Task>={}):Task=>({id:'t1',title:'Design the quota contract',description:'',status:'in_progress',assignee_principal_id:AGENT,version:1,updated_at:new Date().toISOString(),...o});
const pendingDecision:Decision={id:'d1',run_id:null,requested_by_principal_id:AGENT,title:'Publish now?',question:'',rationale:'',proposed_action:{},proposed_action_digest:'a'.repeat(64),status:'pending',version:1,resolved_by_principal_id:null,resolution_note:null,requested_at:new Date().toISOString(),resolved_at:null,expires_at:null};
const describe_=(member:Member,tasks:Task[]=[],decisions:Decision[]=[])=>describePresence(member,{tasks,decisions,members:[member,peer]});

describe('agent presence',()=>{
  it('reports reachability before anything else, because a silent agent is not working',()=>{
    // A stale session still claims a working runtime; being unreachable is the truth that matters.
    const stale=describe_(agent({agent_presence:'stale',agent_runtime_status:'working',agent_last_seen_at:'2026-08-27T10:00:00Z'}),[task()]);
    expect(stale).toMatchObject({label:'Unresponsive',tone:'wait',since:'2026-08-27T10:00:00Z'});

    expect(describe_(agent({agent_presence:'offline',agent_last_seen_at:'2026-08-27T09:00:00Z'}))).toMatchObject({label:'Offline',tone:'gone'});
    expect(describe_(agent({agent_presence:'revoked'}))).toMatchObject({label:'Access revoked',tone:'stop'});
    expect(describe_(agent({agent_presence:'never'}))).toMatchObject({label:'Never connected',tone:'gone'});
    expect(describe_(agent({agent_presence:'never'})).since).toBeUndefined();
  });

  it('distinguishes working, idle, and what the work is',()=>{
    const working=describe_(agent({agent_presence:'connected',agent_runtime_status:'working'}),[task()]);
    expect(working).toMatchObject({label:'Working',tone:'live',detail:'Design the quota contract'});

    const idle=describe_(agent({agent_presence:'connected',agent_runtime_status:'idle'}));
    expect(idle).toMatchObject({label:'Idle',tone:'idle'});
    // Nothing is claimed about an idle agent beyond its being available.
    expect(idle.detail).toBeUndefined();
  });

  it('names the peer an agent is waiting on, from a real dependency',()=>{
    const blocked=task({status:'open',blocked_by:[{task_id:'t2',title:'Investigate',status:'in_progress',assignee_principal_id:PEER}]});
    expect(describe_(agent({agent_presence:'connected',agent_runtime_status:'idle'}),[blocked]))
      .toMatchObject({label:'Waiting on Agent A',tone:'wait',detail:'Design the quota contract'});
  });

  it('falls back to unnamed waiting when the blocking work has no owner',()=>{
    const blocked=task({status:'open',blocked_by:[{task_id:'t2',title:'Investigate',status:'open',assignee_principal_id:null}]});
    expect(describe_(agent({agent_presence:'connected',agent_runtime_status:'idle'}),[blocked]).label).toBe('Waiting on other work');
  });

  it('puts a pending decision ahead of both working and waiting',()=>{
    // Work has stopped and only a human can restart it, so that is what the row must say.
    const stopped=describe_(agent({agent_presence:'connected',agent_runtime_status:'working'}),[task({status:'awaiting_decision'})],[pendingDecision]);
    expect(stopped).toMatchObject({label:'Waiting for your decision',tone:'wait'});
  });

  it('ignores another agent’s decision and another agent’s work',()=>{
    const theirs={...pendingDecision,requested_by_principal_id:PEER};
    const theirTask=task({assignee_principal_id:PEER,status:'awaiting_decision'});
    expect(describe_(agent({agent_presence:'connected',agent_runtime_status:'idle'}),[theirTask],[theirs]).label).toBe('Idle');
  });

  it('never claims a state the engine cannot prove',()=>{
    const every=[
      describe_(agent({agent_presence:'connected',agent_runtime_status:'working'}),[task()]),
      describe_(agent({agent_presence:'connected',agent_runtime_status:'idle'})),
      describe_(agent({agent_presence:'stale'})),
      describe_(agent({agent_presence:'offline'})),
      describe_(agent({agent_presence:'revoked'})),
      describe_(agent({agent_presence:'never'})),
    ].map(p=>p.label.toLowerCase());
    // No thinking, reasoning, planning, or reconnecting: none of those are knowable here.
    for(const forbidden of ['think','reason','plan','analy','reconnect'])
      expect(every.some(label=>label.includes(forbidden))).toBe(false);
  });
});

describe('elapsed labels',()=>{
  const base=Date.parse('2026-08-27T12:00:00Z');
  const at=(secondsAgo:number)=>new Date(base-secondsAgo*1000).toISOString();

  it('is coarse enough that it does not rewrite itself between meaningful changes',()=>{
    expect(elapsedLabel(at(0),base)).toBe('just now');
    expect(elapsedLabel(at(30),base)).toBe('just now');
    // Anything under the threshold reads identically, so a ticking clock changes nothing.
    expect(elapsedLabel(at(10),base)).toBe(elapsedLabel(at(40),base));
    expect(elapsedLabel(at(180),base)).toBe('3 min ago');
    expect(elapsedLabel(at(3600),base)).toBe('1 hr ago');
    expect(elapsedLabel(at(86_400*2),base)).toBe('2 d ago');
  });

  it('says nothing when there is no timestamp to measure from',()=>{
    expect(elapsedLabel(null,base)).toBeNull();
    expect(elapsedLabel(undefined,base)).toBeNull();
    expect(elapsedLabel('not a date',base)).toBeNull();
  });

  it('never reports the future as elapsed time',()=>{
    expect(elapsedLabel(new Date(base+60_000).toISOString(),base)).toBe('just now');
  });
});

/**
 * An agent connected to a different room.
 *
 * A room shows only its own members' sessions, so an agent bound elsewhere had no session here
 * and was reported as "Never connected" — the same words as a machine that had never been set
 * up. It cost hours: the workspace said connected, this room said never, and a message addressed
 * to the agent here was never seen by anyone.
 */
describe('an agent whose session is in another room', () => {
  const base = { principal_id: 'p1', display_name: 'JJ', kind: 'agent' as const,
                 role: 'worker_agent' as const, responsibilities: '' };
  const empty = { tasks: [], decisions: [], members: [] };

  it('says where it is, instead of calling it never connected', () => {
    const described = describePresence(
      { ...base, agent_presence: 'never', agent_session_room_name: 'roomr' }, empty);
    expect(described.label).toBe('Connected to roomr, not here');
    expect(described.label).not.toBe('Never connected');
  });

  it('still says never connected when it truly has not', () => {
    const described = describePresence({ ...base, agent_presence: 'never' }, empty);
    expect(described.label).toBe('Never connected');
  });
});
