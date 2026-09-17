/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,describe,expect,it} from 'vitest';
import {DecisionCard,actionSummary} from '../apps/web/src/App';
import type {Decision,Member} from '../apps/web/src/types';

/**
 * What a person is asked to authorise, in their own language. Every name here is a fixture.
 */
const requester:Member={principal_id:'p-agent',display_name:'Fixture Agent',kind:'agent',role:'worker_agent',responsibilities:''};
const decision=(proposed:Record<string,unknown>):Decision=>({
  id:'d1',run_id:'r1',requested_by_principal_id:'p-agent',title:'Publish the rate-limit note?',
  question:'May I publish the verified note to the public docs?',
  rationale:'Publishing is not mine to do without a person.',
  proposed_action:proposed,proposed_action_digest:'a'.repeat(64),status:'pending',version:1,
  resolved_by_principal_id:null,resolution_note:null,requested_at:new Date().toISOString(),resolved_at:null,expires_at:null});

afterEach(cleanup);

describe('reading a proposed action', () => {
  it('names the action and lists its details as plain fields', () => {
    const summary=actionSummary({action:'publish_document',target_path:'/docs/rate-limits',retryAfterSeconds:120,dryRun:false});
    expect(summary.headline).toBe('Publish document');
    expect(summary.fields).toEqual([
      ['Target path','/docs/rate-limits'],
      ['Retry after seconds','120'],
      ['Dry run','No'],
    ]);
    expect(summary.more).toBe(0);
  });

  it('reads nested and list values out, and says how many it did not show', () => {
    const summary=actionSummary({type:'notify',recipients:['ops','support'],limits:{burst:10,window:'1m'},empty:null},2);
    expect(summary.headline).toBe('Notify');
    expect(summary.fields).toEqual([['Recipients','ops, support'],['Limits · Burst','10']]);
    expect(summary.more).toBeGreaterThan(0);
    // Nothing invented when there is nothing to read.
    expect(actionSummary({})).toEqual({headline:null,fields:[],more:0});
    expect(actionSummary(null)).toEqual({headline:null,fields:[],more:0});
  });
});

describe('a decision in the room', () => {
  it('shows the question, why it needs a person, the action as fields, and who asked — and no raw payload', () => {
    render(<DecisionCard decision={decision({action:'publish_document',target_path:'/docs/rate-limits',status_code:429})}
      requester={requester} onResolve={async()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:/Review/}));
    const card=screen.getByTestId('decision-card');

    expect(card).toHaveTextContent('May I publish the verified note to the public docs?');
    expect(card).toHaveTextContent('Publishing is not mine to do without a person.');
    expect(card).toHaveTextContent('Publish document');
    const fields=within(card).getAllByRole('listitem').map(item=>item.textContent);
    expect(fields).toEqual(['Target path/docs/rate-limits','Status code429']);
    // Who asked, said plainly.
    expect(card).toHaveTextContent('Requested by');
    expect(card).toHaveTextContent('Fixture Agent (agent)');
    // What a person deciding must never be handed: the payload, the schema, or a digest.
    expect(card.querySelector('pre')).toBeNull();
    expect(card.textContent).not.toMatch(/[{}[\]]|"target_path"|aaaaaaaa/);
    expect(card).toHaveTextContent('Approving authorises exactly this, and nothing else.');
    // Both answers are still one press away.
    expect(within(card).getByRole('button',{name:/Approve/})).toBeEnabled();
    expect(within(card).getByRole('button',{name:/Reject/})).toBeEnabled();
  });

  it('says so plainly when an action carries no details', () => {
    render(<DecisionCard decision={decision({})} requester={requester} onResolve={async()=>{}}/>);
    fireEvent.click(screen.getByRole('button',{name:/Review/}));
    expect(screen.getByTestId('decision-card')).toHaveTextContent('No further details were given.');
  });
});
