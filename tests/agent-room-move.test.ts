import {describe,it,expect,vi} from 'vitest';
import {agentRoomMove,handoffAgentMove} from '../apps/web/src/agent-room-move';
import type {WorkspaceAgent} from '../apps/web/src/api';
const agent:WorkspaceAgent={agent_id:'agent',principal_id:'principal',display_name:'JJ',status:'active',owner_display_name:null,
  connector:{enrolled:true,presence:'connected',runtime_status:'idle',last_seen_at:null,room_id:'a',room_name:'Room A'},rooms:[]};
describe('single-room agent move handoff',()=>{
  it('names both rooms and Cancel opens nothing',()=>{
    const move=agentRoomMove(agent,'company','b','Room B')!;
    expect(move.message).toBe('JJ is currently connected to Room A. Move it to Room B?');
    const open=vi.fn();
    expect(handoffAgentMove(move,()=>false,open)).toBe(false);
    expect(open).not.toHaveBeenCalled();
  });
  it('Confirm hands the target to the credential-owning connector, never enrollment',()=>{
    const open=vi.fn(),confirm=vi.fn(()=>true);
    const move=agentRoomMove(agent,'company','b','Room B')!;
    expect(handoffAgentMove(move,confirm,open)).toBe(true);
    expect(open).toHaveBeenCalledExactlyOnceWith('multiplayerai://connect-runtime?company=company&room=b&agent=principal');
    expect(confirm).toHaveBeenCalledExactlyOnceWith(move.message);
  });
  it('does not ask to move within the same room or before first connection',()=>{
    expect(agentRoomMove(agent,'company','a','Room A')).toBeNull();
    expect(agentRoomMove({...agent,connector:{...agent.connector,room_id:null}},'company','b','Room B')).toBeNull();
  });
});
