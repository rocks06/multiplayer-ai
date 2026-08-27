import type {Decision,Member,Task} from './types';

/** live: doing work · wait: needs something · idle: available · gone: not there · stop: refused */
export type PresenceTone='live'|'wait'|'idle'|'gone'|'stop';

export interface AgentPresence{
  /** Whether the Gateway can reach it at all, straight from durable session state. */
  reachable:'connected'|'stale'|'offline'|'revoked'|'never';
  /** What it is doing, in words a person can act on. */
  label:string;
  tone:PresenceTone;
  /** The work this state is about, when there is one. Never invented. */
  detail?:string;
  /** Timestamp the label's elapsed reading is measured from, when one is true. */
  since?:string|null;
}

const openStatuses=['open','in_progress','blocked','awaiting_decision'];

/**
 * Describe an agent from state the engine can prove: durable Gateway session state for whether
 * it is reachable, its own reported runtime status for whether it is busy, and real tasks and
 * decisions for what it is waiting on.
 *
 * Deliberately absent: anything about what an agent is thinking, planning, or capable of, and
 * any notion of "reconnecting" — a runtime that has lost its connection cannot tell the Gateway
 * so, and guessing it from a silent session would be inference dressed as fact.
 */
export function describePresence(
  member:Member,
  context:{tasks:Task[];decisions:Decision[];members:Member[]},
):AgentPresence{
  const reachable=member.agent_presence??'never';
  const seen=member.agent_last_seen_at??null;

  if(reachable==='revoked')return {reachable,label:'Access revoked',tone:'stop',since:seen};
  if(reachable==='never')return {reachable,label:'Never connected',tone:'gone'};
  if(reachable==='offline')return {reachable,label:'Offline',tone:'gone',since:seen};
  if(reachable==='stale')return {reachable,label:'Unresponsive',tone:'wait',since:seen};

  const mine=context.tasks.filter(task=>task.assignee_principal_id===member.principal_id&&openStatuses.includes(task.status));

  // A decision this agent asked for has stopped it, and only a human can restart it.
  const decision=context.decisions.find(d=>d.requested_by_principal_id===member.principal_id&&d.status==='pending');
  const awaiting=mine.find(task=>task.status==='awaiting_decision');
  if(decision||awaiting)return {reachable,label:'Waiting for your decision',tone:'wait',detail:awaiting?.title??decision?.title};

  // Waiting on a peer is a modelled dependency, never inferred from an unanswered message.
  for(const task of mine){
    const blocker=(task.blocked_by??[])[0];
    if(!blocker)continue;
    const owner=context.members.find(m=>m.principal_id===blocker.assignee_principal_id);
    return {reachable,label:owner?`Waiting on ${owner.display_name}`:'Waiting on other work',tone:'wait',detail:task.title};
  }

  if(member.agent_runtime_status==='working'){
    const active=mine.find(task=>task.status==='in_progress')??mine[0];
    return {reachable,label:'Working',tone:'live',detail:active?.title};
  }
  return {reachable,label:'Idle',tone:'idle'};
}

/**
 * A coarse, stable reading of how long ago something happened. The granularity matches how
 * often the value can change, so a label does not rewrite itself between meaningful updates.
 */
export function elapsedLabel(since:string|null|undefined,now:number):string|null{
  if(!since)return null;
  const at=Date.parse(since);
  if(Number.isNaN(at))return null;
  const seconds=Math.max(0,Math.round((now-at)/1000));
  if(seconds<45)return 'just now';
  const minutes=Math.round(seconds/60);
  if(minutes<60)return `${minutes} min ago`;
  const hours=Math.round(minutes/60);
  if(hours<24)return `${hours} hr ago`;
  return `${Math.round(hours/24)} d ago`;
}
