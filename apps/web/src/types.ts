export type PrincipalKind='human'|'agent';
export type RoomRole='manager'|'contributor'|'worker_agent';
export type TaskStatus='open'|'in_progress'|'blocked'|'awaiting_decision'|'completed'|'cancelled';

export type AgentPresence='connected'|'stale'|'offline'|'revoked'|'never';
export interface Member {principal_id:string;display_name:string;kind:PrincipalKind;role:RoomRole;responsibilities:string;agent_presence?:AgentPresence|null;agent_connection?:string|null;agent_runtime_status?:'idle'|'working'|null;agent_last_seen_at?:string|null}
export interface Task {id:string;title:string;description:string;status:TaskStatus;assignee_principal_id:string|null;version:number;updated_at:string}
export interface Message {id:string;sender_principal_id:string;addressed_principal_id:string|null;body_text:string;task_id:string|null;created_at:string;sender_name:string;sender_kind:PrincipalKind}
export interface Decision {id:string;run_id:string|null;requested_by_principal_id:string;title:string;question:string;rationale:string;proposed_action:Record<string,unknown>;proposed_action_digest:string;status:'pending'|'approved'|'rejected'|'cancelled'|'expired';version:number;resolved_by_principal_id:string|null;resolution_note:string|null;requested_at:string;resolved_at:string|null;expires_at:string|null}
export interface RoomEvent {id?:string;room_seq:number;event_type:string;actor_principal_id:string;actor_kind:'human'|'agent'|'system';actor_display_name:string;entity_type:string;entity_id:string;entity_version:number|null;payload:Record<string,unknown>;created_at:string}
export interface RoomSnapshot {
  room:{id:string;name:string;last_event_seq:string|number;project_id:string;project_name:string;objective:string};
  members:Member[];tasks:Task[];messages:Message[];snapshot_seq:number;
  briefing:{briefing_seq:number;project_objective:string;participants:Member[];joining_principal:{principal_id:string;role:RoomRole;responsibilities:string};active_tasks:Task[];relevant_completed_work:Task[];unresolved_decisions:Decision[];blockers:Task[];relevant_artifacts:unknown[];important_recent_activity:RoomEvent[]};
}
export type ConnectionState='connecting'|'live'|'reconnecting'|'resyncing'|'offline'|'revoked';
export interface RoomIdentity {companyId:string;roomId:string;principalId:string}
export interface ApiErrorShape {error?:{code?:string;message?:string;details?:Record<string,unknown>}}
