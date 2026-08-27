/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AgentControls,SharedWork,type WorkActions} from '../apps/web/src/Work';
import {ApiError} from '../apps/web/src/api';
import type {CompanyAgent,Member,Task} from '../apps/web/src/types';

const HUMAN='00000000-0000-4000-8000-0000000000f1';
const COLEMAN='00000000-0000-4000-8000-0000000000c1';
const JJ='00000000-0000-4000-8000-0000000000c2';

const members:Member[]=[
  {principal_id:HUMAN,display_name:'Rocco',kind:'human',role:'manager',responsibilities:''},
  {principal_id:COLEMAN,display_name:'Coleman',kind:'agent',role:'worker_agent',responsibilities:''},
  {principal_id:JJ,display_name:'JJ',kind:'agent',role:'worker_agent',responsibilities:''},
];
const agents=members.filter(m=>m.kind==='agent');

const task=(o:Partial<Task>&{id:string}):Task=>({
  title:'Publish the developer documentation',description:'',status:'open',
  assignee_principal_id:COLEMAN,version:2,updated_at:new Date().toISOString(),...o});
const design=task({id:'design',title:'Design the published quota contract',assignee_principal_id:JJ});
const blocked=task({id:'docs',blocked_by:[{task_id:'design',title:'Design the published quota contract',status:'open',assignee_principal_id:JJ}]});

function stubActions(over:Partial<WorkActions>={}):WorkActions{
  const noop=vi.fn(async()=>({}));
  return {setStatus:noop,reassign:noop,addDependency:noop,removeDependency:noop,override:noop,pause:noop,resume:noop,...over};
}
const work=(props:Partial<Parameters<typeof SharedWork>[0]>={})=>render(
  <SharedWork tasks={[design,blocked]} members={members} agents={agents} canManage currentId={HUMAN}
    actions={stubActions()} {...props}/>);

afterEach(cleanup);

describe('Stage 6 shared work',()=>{
  it('names what is holding work up, and who owns that work',()=>{
    work();
    const row=screen.getByText('Publish the developer documentation').closest('li')!;
    // The peer is named because the blocking work belongs to someone else.
    expect(within(row).getByText(/Coleman · Waiting on JJ/)).toBeVisible();
    // And the blocking work itself is named, from the recorded dependency.
    expect(within(row).getByText('Design the published quota contract — JJ · Open')).toBeVisible();
  });

  it('names the work rather than the person when the blocker has the same owner',()=>{
    const own=task({id:'docs',blocked_by:[{task_id:'design',title:'Earlier step',status:'open',assignee_principal_id:COLEMAN}]});
    work({tasks:[own]});
    expect(screen.getByText(/Coleman · Waiting on earlier work/)).toBeVisible();
  });

  it('stops calling work blocked once its dependency has been overridden',()=>{
    const overridden=task({id:'docs',status:'in_progress',dependency_override_at:new Date().toISOString(),
      blocked_by:[{task_id:'design',title:'Design the published quota contract',status:'open',assignee_principal_id:JJ}]});
    work({tasks:[overridden]});
    expect(screen.getByText(/Coleman · In progress/)).toBeVisible();
    expect(screen.queryByText(/Waiting on/)).not.toBeInTheDocument();
    expect(screen.getByText(/Overridden by a manager and recorded/)).toBeVisible();
  });

  it('reports the guard in terms of the work that is not finished',async()=>{
    const setStatus=vi.fn(async()=>{throw new ApiError('Task has incomplete dependencies','task_dependencies_incomplete',409,
      {blocked_by:[{task_id:'design',title:'Design the published quota contract'}]})});
    work({actions:stubActions({setStatus})});
    fireEvent.click(screen.getByRole('button',{name:'Manage Publish the developer documentation'}));
    fireEvent.click(screen.getByRole('button',{name:'Start'}));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Not started — this work depends on “Design the published quota contract”, which is not finished.');
  });

  it('presents an override as bypassing a constraint on the record, not as continuing',async()=>{
    const override=vi.fn(async()=>({}));
    work({actions:stubActions({override})});
    fireEvent.click(screen.getByRole('button',{name:'Manage Publish the developer documentation'}));
    fireEvent.click(screen.getByRole('button',{name:/Override this constraint/}));

    expect(screen.getByText('You are bypassing a work constraint')).toBeVisible();
    expect(screen.getByText(/recorded in the room as your decision, with the reason you give/)).toBeVisible();
    // The unfinished work being set aside is named there, not summarised as a count.
    const panel=screen.getByRole('region',{name:'Override dependency'});
    expect(within(panel).getByText('Design the published quota contract — JJ · Open')).toBeVisible();
    // Nothing here reads as an ordinary "continue anyway" affordance.
    const commit=screen.getByRole('button',{name:'Override and record'});
    expect(screen.queryByRole('button',{name:/continue/i})).not.toBeInTheDocument();

    // A reason is required: the server demands one, and so does the control.
    expect(commit).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox'),{target:{value:'Outline can start from the agreed shape.'}});
    await waitFor(()=>expect(commit).toBeEnabled());
    fireEvent.click(commit);
    await waitFor(()=>expect(override).toHaveBeenCalledWith(expect.objectContaining({id:'docs'}),'Outline can start from the agreed shape.'));
  });

  it('asks before ending work for good',async()=>{
    const setStatus=vi.fn(async()=>({}));
    work({actions:stubActions({setStatus})});
    fireEvent.click(screen.getByRole('button',{name:'Manage Publish the developer documentation'}));
    fireEvent.click(screen.getByRole('button',{name:'Cancel work'}));
    expect(screen.getByText(/stops for good and cannot be reopened/)).toBeVisible();
    expect(setStatus).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button',{name:'Cancel work'}).at(-1)!);
    await waitFor(()=>expect(setStatus).toHaveBeenCalledWith(expect.objectContaining({id:'docs'}),'cancelled'));
  });

  it('offers nothing to change on work that has already ended',()=>{
    work({tasks:[task({id:'docs',status:'cancelled'})]});
    expect(screen.queryByRole('button',{name:/Manage/})).not.toBeInTheDocument();
  });

  it('gives a contributor their own work without a manager’s authority',()=>{
    const mine=task({id:'docs',assignee_principal_id:HUMAN,
      blocked_by:[{task_id:'design',title:'Design the published quota contract',status:'open',assignee_principal_id:JJ}]});
    work({tasks:[mine],canManage:false});
    fireEvent.click(screen.getByRole('button',{name:'Manage Publish the developer documentation'}));
    // Their own work can be moved…
    expect(screen.getByRole('button',{name:'Start'})).toBeVisible();
    // …but who owns it, what it depends on, and setting the constraint aside are not theirs.
    expect(screen.queryByLabelText(/^Owner of/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Add a dependency/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:/Override this constraint/})).not.toBeInTheDocument();
  });

  it('shows a contributor no management affordance on work that is not theirs',()=>{
    work({canManage:false});
    expect(screen.queryByRole('button',{name:/Manage/})).not.toBeInTheDocument();
  });
});

describe('Stage 6 agent supervision',()=>{
  const coleman=members[1]!;
  const record:CompanyAgent={agent_id:'agent-1',principal_id:COLEMAN,display_name:'Coleman',status:'active'};
  const controls=(props:Partial<Parameters<typeof AgentControls>[0]>={})=>render(
    <AgentControls member={coleman} agent={record} canManage actions={stubActions()} onMessage={vi.fn()} {...props}/>);

  it('stays out of the way until it is asked for',()=>{
    controls();
    expect(screen.queryByRole('button',{name:/^Pause/})).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'Supervise Coleman'}));
    expect(screen.getByRole('button',{name:'Pause Coleman'})).toBeVisible();
  });

  it('claims only what the engine can guarantee about pausing',()=>{
    controls();
    fireEvent.click(screen.getByRole('button',{name:'Supervise Coleman'}));
    fireEvent.click(screen.getByRole('button',{name:'Pause Coleman'}));
    const note=screen.getByText(/New work stops now/);
    // What is guaranteed: nothing it sends back is accepted.
    expect(note).toHaveTextContent('nothing Coleman sends back will be accepted');
    // What is not: that a process on another machine stopped on command.
    expect(note).toHaveTextContent('may still be finishing the step it started');
    expect(note.textContent).not.toMatch(/stopped immediately|has stopped|halted/i);
  });

  it('offers resume for a paused agent, without implying cancelled work returns',()=>{
    controls({agent:{...record,status:'paused'}});
    fireEvent.click(screen.getByRole('button',{name:'Supervise Coleman'}));
    expect(screen.getByRole('button',{name:'Resume Coleman'})).toBeVisible();
    expect(screen.getByText(/Resuming does not restart what was cancelled/)).toBeVisible();
  });

  it('says plainly when an agent cannot be paused from here',()=>{
    controls({agent:undefined});
    fireEvent.click(screen.getByRole('button',{name:'Supervise Coleman'}));
    expect(screen.getByText(/not registered to the workspace/)).toBeVisible();
    expect(screen.queryByRole('button',{name:/^Pause/})).not.toBeInTheDocument();
  });

  it('shows a contributor no supervisory controls at all',()=>{
    const {container}=controls({canManage:false});
    expect(container).toBeEmptyDOMElement();
  });
});
