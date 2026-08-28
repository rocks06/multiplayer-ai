/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Welcome,{connectionOf,resumeAt,UNSET_OBJECTIVE} from '../apps/web/src/Welcome';
import type {WorkspaceAgent,WorkspaceRoom} from '../apps/web/src/api';

vi.mock('../apps/web/src/api',async importOriginal=>{
  const actual=await importOriginal<typeof import('../apps/web/src/api')>();
  return {...actual,
    currentIdentity:vi.fn(),listWorkspaceAgents:vi.fn(),listWorkspaceRooms:vi.fn(),
    createWorkspace:vi.fn(),addWorkspaceAgent:vi.fn(),createEnrollmentCode:vi.fn(),
    createProject:vi.fn(),createRoom:vi.fn(),addRoomMember:vi.fn(),setProjectObjective:vi.fn()};
});
const api=await import('../apps/web/src/api');

const identity={user:{id:'u1',email:'sam@example.com',display_name:'Sam Rivera'},companies:[]as any[]};
const withWorkspace={...identity,companies:[{company_id:'c1',company_name:'Northwind',principal_id:'p1',display_name:'Sam Rivera'}]};
const workspace={companyId:'c1',name:'Northwind'};
const room=(objective=UNSET_OBJECTIVE):WorkspaceRoom=>({room_id:'r1',name:'Developer API',project_id:'j1',project_name:'Developer API',objective});
const agent=(display_name:string,presence:WorkspaceAgent['connector']['presence']='never'):WorkspaceAgent=>({
  agent_id:`a-${display_name}`,principal_id:`p-${display_name}`,display_name,status:'active',owner_display_name:'Sam Rivera',
  connector:{enrolled:presence!=='never',presence,runtime_status:presence==='connected'?'idle':null,last_seen_at:null},
  rooms:[{room_id:'r1',name:'Developer API'}],
});
function arrive(me:any,agents:WorkspaceAgent[]=[],rooms:WorkspaceRoom[]=[]){
  vi.mocked(api.currentIdentity).mockResolvedValue(me);
  vi.mocked(api.listWorkspaceAgents).mockResolvedValue(agents);
  vi.mocked(api.listWorkspaceRooms).mockResolvedValue(rooms);
}
const navigate=vi.fn();
const show=()=>render(<Welcome navigate={navigate}/>);

beforeEach(()=>{vi.clearAllMocks()});
afterEach(cleanup);

describe('corrected onboarding order and durable resume',()=>{
  it('derives every partial-completion step from persisted workspace state',()=>{
    expect(resumeAt(null,[],[])).toBe('workspace');
    expect(resumeAt(workspace,[],[])).toBe('agents');
    expect(resumeAt(workspace,[agent('Coleman')],[])).toBe('room');
    expect(resumeAt(workspace,[agent('Coleman')],[room()])).toBe('connect');
    expect(resumeAt(workspace,[agent('Coleman','connected'),agent('JJ')],[room()])).toBe('connect');
    expect(resumeAt(workspace,[agent('Coleman','connected'),agent('JJ','offline')],[room()])).toBe('objective');
    expect(resumeAt(workspace,[agent('Coleman')],[room('Ship the API')])).toBe('ready');
  });

  it('adds agents without offering enrollment before a room exists',async()=>{
    arrive(withWorkspace);
    vi.mocked(api.addWorkspaceAgent).mockResolvedValue({agent_id:'a-Coleman',principal_id:'p-Coleman'});
    vi.mocked(api.listWorkspaceAgents).mockResolvedValueOnce([]).mockResolvedValue([agent('Coleman')]);
    show();
    fireEvent.change(await screen.findByLabelText('What do you call this agent?'),{target:{value:'Coleman'}});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Add agent'})));
    expect(await screen.findByText('Not connected yet')).toBeVisible();
    expect(screen.queryByRole('button',{name:'Connect this agent'})).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Next: create a room'})).toBeEnabled();
  });

  it('creates the project, room, and memberships before exposing the existing enrollment component',async()=>{
    const coleman=agent('Coleman'),jj=agent('JJ');
    arrive(withWorkspace,[coleman,jj],[]);
    vi.mocked(api.createProject).mockResolvedValue({id:'j1',name:'Developer API',objective:UNSET_OBJECTIVE});
    vi.mocked(api.createRoom).mockResolvedValue({id:'r1',name:'Developer API'});
    vi.mocked(api.addRoomMember).mockResolvedValue({});
    vi.mocked(api.listWorkspaceRooms).mockResolvedValueOnce([]).mockResolvedValue([room()]);
    show();
    fireEvent.change(await screen.findByLabelText('Room name'),{target:{value:'Developer API'}});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Create the room'})));
    await waitFor(()=>expect(api.addRoomMember).toHaveBeenCalledTimes(2));
    expect(api.createProject).toHaveBeenCalledWith('c1','Developer API',UNSET_OBJECTIVE);
    expect(api.addRoomMember).toHaveBeenCalledWith('c1','r1','p-Coleman','');
    expect(api.addRoomMember).toHaveBeenCalledWith('c1','r1','p-JJ','');
    expect(await screen.findAllByRole('button',{name:'Connect this agent'})).toHaveLength(2);
    expect(screen.getByRole('button',{name:'Next: set the first objective'})).toBeDisabled();
  });

  it('remains at Connect while any required agent is Never connected',async()=>{
    arrive(withWorkspace,[agent('Coleman','connected'),agent('JJ')],[room()]);
    show();
    expect(await screen.findByRole('heading',{name:'Connect your agents'})).toBeVisible();
    expect(screen.getByRole('button',{name:'Next: set the first objective'})).toBeDisabled();
    expect(screen.queryByLabelText('What are they trying to achieve?')).not.toBeInTheDocument();
  });

  it('moves to First Objective once every required agent has genuinely appeared',async()=>{
    arrive(withWorkspace,[agent('Coleman','connected'),agent('JJ','stale')],[room()]);
    show();
    expect(await screen.findByRole('heading',{name:'Set the first objective'})).toBeVisible();
    fireEvent.change(screen.getByLabelText('What are they trying to achieve?'),{target:{value:'Ship the API'}});
    vi.mocked(api.setProjectObjective).mockResolvedValue({id:'j1',name:'Developer API',objective:'Ship the API'});
    await act(async()=>fireEvent.click(screen.getByRole('button',{name:'Enter the room'})));
    expect(api.setProjectObjective).toHaveBeenCalledWith('c1','j1','Ship the API',UNSET_OBJECTIVE);
    expect(navigate).toHaveBeenCalledWith('/rooms/c1/r1');
  });

  it('an existing real objective enters the ready-room path instead of restarting onboarding',async()=>{
    arrive(withWorkspace,[agent('Coleman')],[room('Ship the API')]);
    show();
    expect(await screen.findByRole('heading',{name:'Northwind is ready'})).toBeVisible();
    expect(screen.queryByRole('heading',{name:'Connect your agents'})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:/Developer API/}));
    expect(navigate).toHaveBeenCalledWith('/rooms/c1/r1');
  });
});

describe('the reused enrollment component',()=>{
  it('shows a real single-use code only after the room exists',async()=>{
    arrive(withWorkspace,[agent('Coleman')],[room()]);
    vi.mocked(api.createEnrollmentCode).mockResolvedValue({enrollment_code:'MPAI-82HT-KT87-BZ74',expires_at:new Date(Date.now()+900_000).toISOString()});
    show();
    fireEvent.click(await screen.findByRole('button',{name:'Connect this agent'}));
    expect(await screen.findByText('MPAI-82HT-KT87-BZ74')).toBeVisible();
    expect(screen.getByText(/It can be used once/)).toBeVisible();
  });

  it('never claims a connection the Gateway has not seen',()=>{
    expect(connectionOf(agent('A'))).toMatchObject({label:'Not connected yet',arrived:false});
    expect(connectionOf(agent('A','connected'))).toMatchObject({label:'Connected',arrived:true});
    expect(connectionOf(agent('A','offline'))).toMatchObject({arrived:true});
  });

  it('reports enrollment-code failures rather than appearing to succeed',async()=>{
    arrive(withWorkspace,[agent('Coleman')],[room()]);
    vi.mocked(api.createEnrollmentCode).mockRejectedValue(new api.ApiError('Agent not found','agent_not_found',404));
    show();
    fireEvent.click(await screen.findByRole('button',{name:'Connect this agent'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent not found');
  });
});
