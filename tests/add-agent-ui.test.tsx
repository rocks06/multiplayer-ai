/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Participants} from '../apps/web/src/App';
import type {CompanyAgent,Decision,Member,Task} from '../apps/web/src/types';

/**
 * Agents arrive whenever the person has one, not only during their first hour. A room shows the
 * agents that were put in it — no more, and never on its own.
 */
const HUMAN='00000000-0000-4000-8000-0000000000f1';
const A='00000000-0000-4000-8000-0000000000a1';
const B='00000000-0000-4000-8000-0000000000b1';

const human:Member={principal_id:HUMAN,display_name:'Priya',kind:'human',role:'manager',responsibilities:''};
const agent=(id:string,name:string):Member=>
  ({principal_id:id,display_name:name,kind:'agent',role:'worker_agent',responsibilities:'',agent_presence:'never'});
const record=(id:string,name:string):CompanyAgent=>
  ({agent_id:`rec-${id}`,principal_id:id,display_name:name,status:'active'});

const show=(props:Partial<Parameters<typeof Participants>[0]>={})=>render(
  <Participants members={[human]} currentId={HUMAN} tasks={[] as Task[]} decisions={[] as Decision[]}
    companyAgents={[]} canManage actions={undefined} onMessage={undefined} {...props}/>);

const agentNames=()=>{
  const section=screen.getByRole('heading',{name:'Agents'}).closest('section')!;
  return [...section.querySelectorAll('.person-copy strong')].map(node=>node.textContent);
};

afterEach(cleanup);

describe('Adding agents to a room, whenever you have one', () => {
  it('shows a room with no agents as empty rather than inventing any', () => {
    show({onAddAgent: vi.fn()});
    expect(agentNames()).toEqual([]);
    expect(screen.getByText(/No agents here yet/)).toBeVisible();
  });

  it('shows only the agents that are members of this room', () => {
    // Agent B exists in the workspace but was never added here, so it is not in the room.
    show({members:[human,agent(A,'Agent A')],companyAgents:[record(A,'Agent A'),record(B,'Agent B')],onAddAgent:vi.fn()});
    expect(agentNames()).toEqual(['Agent A']);
  });

  it('offers the workspace agents that are not already here, and nothing else', () => {
    show({members:[human,agent(A,'Agent A')],companyAgents:[record(A,'Agent A'),record(B,'Agent B')],onAddAgent:vi.fn()});
    fireEvent.click(screen.getByRole('button',{name:/Add agent/}));
    const choices = within(screen.getByLabelText('Add an agent already in this workspace'))
      .getAllByRole('option').map(option => option.textContent);
    expect(choices).toEqual(['Choose an agent…','Agent B']);
  });

  it('adds an agent the workspace already knows to this room', async () => {
    const onAddAgent=vi.fn(async()=>{});
    show({members:[human,agent(A,'Agent A')],companyAgents:[record(A,'Agent A'),record(B,'Agent B')],onAddAgent});
    fireEvent.click(screen.getByRole('button',{name:/Add agent/}));
    fireEvent.change(screen.getByLabelText('Add an agent already in this workspace'),{target:{value:B}});
    await waitFor(()=>expect(onAddAgent).toHaveBeenCalledWith({principalId:B}));
  });

  it('registers a newly named agent and adds it here', async () => {
    const onAddAgent=vi.fn(async()=>{});
    show({onAddAgent});
    fireEvent.click(screen.getByRole('button',{name:/Add agent/}));
    fireEvent.change(screen.getByLabelText('Agent name'),{target:{value:'Agent A'}});
    fireEvent.click(screen.getByRole('button',{name:'Add agent'}));
    await waitFor(()=>expect(onAddAgent).toHaveBeenCalledWith({name:'Agent A'}));
  });

  it('can be repeated, so a second and third agent are no harder than the first', async () => {
    const onAddAgent=vi.fn(async()=>{});
    const {rerender}=show({members:[human,agent(A,'Agent A')],companyAgents:[record(A,'Agent A')],onAddAgent});
    fireEvent.click(screen.getByRole('button',{name:/Add agent/}));
    fireEvent.change(screen.getByLabelText('Agent name'),{target:{value:'Agent B'}});
    fireEvent.click(screen.getByRole('button',{name:'Add agent'}));
    await waitFor(()=>expect(onAddAgent).toHaveBeenCalledWith({name:'Agent B'}));

    // Once it is a member, the room simply shows it, and the path is still there for the next.
    rerender(<Participants members={[human,agent(A,'Agent A'),agent(B,'Agent B')]} currentId={HUMAN}
      tasks={[]} decisions={[]} companyAgents={[record(A,'Agent A'),record(B,'Agent B')]} canManage onAddAgent={onAddAgent}/>);
    expect(agentNames()).toEqual(['Agent A','Agent B']);
    expect(screen.getByRole('button',{name:/Add agent/})).toBeVisible();
  });

  it('says what naming an agent here does, and does not imply we make one', () => {
    show({onAddAgent: vi.fn()});
    fireEvent.click(screen.getByRole('button',{name:/Add agent/}));
    expect(screen.getByText(/Names an agent you already run/)).toBeVisible();
    const panel=screen.getByLabelText('Agent name').closest('form')!.textContent!;
    for(const forbidden of [/create an agent/i,/new AI/i,/API key/i,/model/i,/provider/i])
      expect(panel).not.toMatch(forbidden);
  });

  it('offers nothing to someone without authority in the room', () => {
    show({members:[human,agent(A,'Agent A')],companyAgents:[record(A,'Agent A')],canManage:false,onAddAgent:vi.fn()});
    expect(screen.queryByRole('button',{name:/Add agent/})).not.toBeInTheDocument();
  });
});
