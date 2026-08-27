/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import Welcome,{connectionOf,resumeAt} from '../apps/web/src/Welcome';
import type {WorkspaceAgent,WorkspaceRoom} from '../apps/web/src/api';

vi.mock('../apps/web/src/api',async importOriginal=>{
  const actual=await importOriginal<typeof import('../apps/web/src/api')>();
  return {...actual,
    currentIdentity:vi.fn(),listWorkspaceAgents:vi.fn(),listWorkspaceRooms:vi.fn(),
    createWorkspace:vi.fn(),addWorkspaceAgent:vi.fn(),createEnrollmentCode:vi.fn(),
    createProject:vi.fn(),createRoom:vi.fn(),addRoomMember:vi.fn()};
});
const api=await import('../apps/web/src/api');

const identity={user:{id:'u1',email:'sam@example.com',display_name:'Sam Rivera'},companies:[]as any[]};
const withWorkspace={...identity,companies:[{company_id:'c1',company_name:'Northwind',principal_id:'p1',display_name:'Sam Rivera'}]};

const agent=(over:Partial<WorkspaceAgent>&{display_name:string}):WorkspaceAgent=>({
  agent_id:`a-${over.display_name}`,principal_id:`p-${over.display_name}`,status:'active',owner_display_name:'Sam Rivera',
  connector:{enrolled:false,presence:'never',runtime_status:null,last_seen_at:null},rooms:null,...over});
const room:WorkspaceRoom={room_id:'r1',name:'Developer API',project_id:'j1',project_name:'Developer API'};

function arrive(me:any,agents:WorkspaceAgent[]=[],rooms:WorkspaceRoom[]=[]){
  vi.mocked(api.currentIdentity).mockResolvedValue(me);
  vi.mocked(api.listWorkspaceAgents).mockResolvedValue(agents);
  vi.mocked(api.listWorkspaceRooms).mockResolvedValue(rooms);
}
const navigate=vi.fn();
const show=()=>render(<Welcome navigate={navigate}/>);

beforeEach(()=>{vi.clearAllMocks()});
afterEach(cleanup);

describe('where onboarding picks you up',()=>{
  const connected=agent({display_name:'Coleman',rooms:[{room_id:'r1',name:'Developer API'}],
    connector:{enrolled:true,presence:'connected',runtime_status:'idle',last_seen_at:null}});
  const enrolled=agent({display_name:'Coleman',connector:{enrolled:true,presence:'never',runtime_status:null,last_seen_at:null}});

  it('reads the workspace rather than remembering a step',()=>{
    expect(resumeAt(null,[],[])).toBe('workspace');
    expect(resumeAt({companyId:'c1',name:'N'},[],[])).toBe('agents');
    // An agent nobody has set up yet is unfinished business, so it does not move past it.
    expect(resumeAt({companyId:'c1',name:'N'},[agent({display_name:'Coleman'})],[])).toBe('agents');
    expect(resumeAt({companyId:'c1',name:'N'},[enrolled],[])).toBe('objective');
    expect(resumeAt({companyId:'c1',name:'N'},[connected],[room])).toBe('ready');
  });
});

describe('what an agent’s state is allowed to claim',()=>{
  it('never reports a connection the Gateway has not seen',()=>{
    expect(connectionOf(agent({display_name:'A'}))).toMatchObject({label:'Not connected yet',arrived:false,ready:false});
    // Enrolled with nowhere to join: saying it is "waiting to appear" would promise nothing real.
    expect(connectionOf(agent({display_name:'A',connector:{enrolled:true,presence:'never',runtime_status:null,last_seen_at:null}})))
      .toMatchObject({label:'Set up — it joins once there is a room',arrived:false,ready:true});
    // With a room it genuinely can appear at any moment.
    expect(connectionOf(agent({display_name:'A',rooms:[{room_id:'r1',name:'R'}],
      connector:{enrolled:true,presence:'never',runtime_status:null,last_seen_at:null}})))
      .toMatchObject({label:'Waiting for it to appear',arrived:false});
    expect(connectionOf(agent({display_name:'A',connector:{enrolled:true,presence:'connected',runtime_status:'idle',last_seen_at:null}})))
      .toMatchObject({label:'Connected',arrived:true});
    expect(connectionOf(agent({display_name:'A',connector:{enrolled:true,presence:'revoked',runtime_status:null,last_seen_at:null}})))
      .toMatchObject({arrived:false,ready:false});
  });
});

describe('setting a workspace up',()=>{
  it('starts a first-time person at naming their workspace, focused and ready to type',async()=>{
    arrive(identity);
    show();
    const field=await screen.findByLabelText('Workspace name');
    await waitFor(()=>expect(document.activeElement).toBe(field));
    expect(screen.getByRole('heading',{name:/Bring your agents into one shared workspace/})).toBeVisible();
  });

  it('does not shunt you past connecting the agent you just added',async()=>{
    arrive(withWorkspace);
    show();
    const field=await screen.findByLabelText('What do you call this agent?');
    fireEvent.change(field,{target:{value:'Coleman'}});

    // Adding one is what the workspace then reports back.
    vi.mocked(api.addWorkspaceAgent).mockResolvedValue({agent_id:'a1',principal_id:'p-Coleman'});
    vi.mocked(api.listWorkspaceAgents).mockResolvedValue([agent({display_name:'Coleman'})]);
    fireEvent.click(screen.getByRole('button',{name:'Add agent'}));

    // Still on agents, now offering to connect it — not already asking about the work.
    expect(await screen.findByRole('button',{name:'Connect this agent'})).toBeVisible();
    expect(screen.queryByLabelText('Name this piece of work')).not.toBeInTheDocument();
  });

  it('shows a real code to enter, and says what happens to it',async()=>{
    arrive(withWorkspace,[agent({display_name:'Coleman'})]);
    vi.mocked(api.createEnrollmentCode).mockResolvedValue({
      enrollment_code:'MPAI-82HT-KT87-BZ74',expires_at:new Date(Date.now()+900_000).toISOString()});
    show();
    fireEvent.click(await screen.findByRole('button',{name:'Connect this agent'}));

    expect(await screen.findByText('MPAI-82HT-KT87-BZ74')).toBeVisible();
    expect(screen.getByText(/Enter this in the Connector on the machine where Coleman runs/)).toBeVisible();
    expect(screen.getByText(/It can be used once/)).toBeVisible();
  });

  it('says a lapsed code is spent instead of leaving it on screen',async()=>{
    arrive(withWorkspace,[agent({display_name:'Coleman'})]);
    vi.mocked(api.createEnrollmentCode).mockResolvedValue({
      enrollment_code:'MPAI-DEAD-DEAD-DEAD',expires_at:new Date(Date.now()-1000).toISOString()});
    show();
    fireEvent.click(await screen.findByRole('button',{name:'Connect this agent'}));

    expect(await screen.findByText(/That code expired/)).toBeVisible();
    expect(screen.queryByText('MPAI-DEAD-DEAD-DEAD')).not.toBeInTheDocument();
    expect(screen.getByRole('button',{name:/Get a new code/})).toBeEnabled();
  });

  it('reports a refused code rather than appearing to succeed',async()=>{
    arrive(withWorkspace,[agent({display_name:'Coleman'})]);
    vi.mocked(api.createEnrollmentCode).mockRejectedValue(new api.ApiError('Agent not found','agent_not_found',404));
    show();
    fireEvent.click(await screen.findByRole('button',{name:'Connect this agent'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Agent not found');
    expect(screen.queryByText(/Enter this in the Connector/)).not.toBeInTheDocument();
  });

  it('is honest about what connecting an agent needs, without asking anyone to read a terminal',async()=>{
    arrive(withWorkspace,[agent({display_name:'Coleman'})]);
    show();
    const help=await screen.findByText(/Don’t have the Connector yet\?/);
    fireEvent.click(help);
    const text=help.closest('details')!.textContent!;
    expect(text).toContain('Multiplayer AI Connector');
    expect(text).toMatch(/supported runtime such as Hermes/);
    // Nothing on this screen asks a person to understand how any of it is wired. Matched as
    // whole words, so an innocent "supported" is not mistaken for "port".
    const page=document.body.textContent!;
    for(const jargon of ['principals?','credentials?','gateway','session','environment file',
      'ports?','bridge','node','idempotency','enrollment'])
      expect(page).not.toMatch(new RegExp(`\\b${jargon}\\b`,'i'));
  });

  it('lets someone set the work up before their agents are connected',async()=>{
    arrive(withWorkspace,[agent({display_name:'Coleman'})]);
    show();
    fireEvent.click(await screen.findByRole('button',{name:/Continue without connecting yet/}));
    expect(await screen.findByLabelText('Name this piece of work')).toBeVisible();
    // And going back is always available while setting up.
    fireEvent.click(screen.getByRole('button',{name:'Back to agents'}));
    expect(await screen.findByRole('heading',{name:'Your agents'})).toBeVisible();
  });

  it('puts every agent into the first room, and opens it',async()=>{
    const coleman=agent({display_name:'Coleman',connector:{enrolled:true,presence:'never',runtime_status:null,last_seen_at:null}});
    const jj=agent({display_name:'JJ',connector:{enrolled:true,presence:'never',runtime_status:null,last_seen_at:null}});
    arrive(withWorkspace,[coleman,jj]);
    vi.mocked(api.createProject).mockResolvedValue({id:'j1',name:'Developer API',objective:'Launch it'});
    vi.mocked(api.createRoom).mockResolvedValue({id:'r1',name:'Developer API'});
    vi.mocked(api.addRoomMember).mockResolvedValue({});
    show();

    fireEvent.change(await screen.findByLabelText('Name this piece of work'),{target:{value:'Developer API'}});
    fireEvent.change(screen.getByLabelText('What are they trying to achieve?'),{target:{value:'Launch it'}});
    fireEvent.click(screen.getByRole('button',{name:/Create the room/}));

    await waitFor(()=>expect(api.addRoomMember).toHaveBeenCalledTimes(2));
    expect(api.addRoomMember).toHaveBeenCalledWith('c1','r1','p-Coleman','');
    expect(api.addRoomMember).toHaveBeenCalledWith('c1','r1','p-JJ','');
    await waitFor(()=>expect(navigate).toHaveBeenCalledWith('/rooms/c1/r1'));
  });

  it('gives a returning person their rooms, and says which agents are still missing',async()=>{
    const coleman=agent({display_name:'Coleman',rooms:[{room_id:'r1',name:'Developer API'}],
      connector:{enrolled:true,presence:'connected',runtime_status:'idle',last_seen_at:null}});
    arrive(withWorkspace,[coleman,agent({display_name:'JJ'})],[room]);
    show();
    expect(await screen.findByRole('heading',{name:'Northwind is ready'})).toBeVisible();
    expect(screen.getByText(/JJ is not connected yet/)).toBeVisible();
    fireEvent.click(screen.getByRole('button',{name:/Developer API/}));
    expect(navigate).toHaveBeenCalledWith('/rooms/c1/r1');
  });

  it('sends someone signed out to sign in, and remembers where they were going',async()=>{
    arrive(null);
    show();
    await waitFor(()=>expect(navigate).toHaveBeenCalledWith('/signin'));
    expect(sessionStorage.getItem('mpai:after-sign-in')).toBe('/welcome');
  });

  it('can be worked through without a pointer',async()=>{
    arrive(withWorkspace,[agent({display_name:'Coleman'})]);
    show();
    // Every control on the step is reachable in reading order, and none is a div pretending.
    await screen.findByRole('button',{name:'Connect this agent'});
    const stops=[...document.querySelectorAll('button,input,textarea,summary,[tabindex]')];
    expect(stops.length).toBeGreaterThan(0);
    for(const stop of stops)expect(['BUTTON','INPUT','TEXTAREA','SUMMARY']).toContain(stop.tagName);
    const connect=screen.getByRole('button',{name:'Connect this agent'});
    connect.focus();
    expect(document.activeElement).toBe(connect);
  });
});
