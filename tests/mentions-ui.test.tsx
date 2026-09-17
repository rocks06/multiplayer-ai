/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {AttachmentComposer} from '../apps/web/src/Attachments';
import {Home} from '../apps/web/src/Home';
import {bodySegments,insertMention,mentionCandidates,mentionQuery,mentionRanges} from '../apps/web/src/mentions';
import type {Member} from '../apps/web/src/types';

/** Structured mentions and unread state in the web app. Every name here is a fixture. */
const members:Member[]=[
  {principal_id:'00000000-0000-4000-8000-0000000000a1',display_name:'Fixture Person',kind:'human',role:'contributor',responsibilities:''},
  {principal_id:'00000000-0000-4000-8000-0000000000b1',display_name:'Fixture Agent One',kind:'agent',role:'worker_agent',responsibilities:''},
  {principal_id:'00000000-0000-4000-8000-0000000000b2',display_name:'Fixture Agent Two',kind:'agent',role:'worker_agent',responsibilities:''},
];
afterEach(()=>{cleanup();vi.unstubAllGlobals()});

describe('mention helpers',()=>{
  it('opens only for an @ at a word start, and completes names with spaces',()=>{
    expect(mentionQuery('hello @fix',10)).toEqual({start:6,query:'fix'});
    expect(mentionQuery('@',1)).toEqual({start:0,query:''});
    expect(mentionQuery('mail me at a@b',14)).toBeNull();
    expect(mentionCandidates(members,'agent','').map(m=>m.display_name)).toEqual(['Fixture Agent One','Fixture Agent Two']);
    expect(mentionCandidates(members,'',members[0]!.principal_id).map(m=>m.display_name)).not.toContain('Fixture Person');
    expect(insertMention('ask @fix now',{start:4,query:'fix'},members[1]!)).toEqual({text:'ask @Fixture Agent One  now',caret:23});
  });

  it('sends ranges only for chosen participants, and never for "@Name" typed by hand',()=>{
    const body='@Fixture Agent One and @Fixture Agent Two, thanks @Fixture Agent One';
    const chosen=[{principal_id:members[1]!.principal_id,display_name:'Fixture Agent One'}];
    expect(mentionRanges(body,chosen)).toEqual([{principal_id:members[1]!.principal_id,start:0,end:18}]);
    expect(mentionRanges(body,[...chosen,...chosen])).toEqual([
      {principal_id:members[1]!.principal_id,start:0,end:18},{principal_id:members[1]!.principal_id,start:50,end:68}]);
    expect(mentionRanges('the mention was deleted',chosen)).toEqual([]);
    // A longer name that merely starts with the chosen one is not that mention.
    expect(mentionRanges('@Fixture Agent Ones',chosen)).toEqual([]);
  });

  it('renders a range only where the text still says "@Name"',()=>{
    const mention={principal_id:'p',start:4,end:22,display_name:'Fixture Agent One',kind:'agent' as const};
    expect(bodySegments('Hi, @Fixture Agent One!',[mention]).map(s=>[s.text,Boolean(s.mention)])).toEqual([['Hi, ',false],['@Fixture Agent One',true],['!',false]]);
    expect(bodySegments('Text was edited',[mention]).map(s=>s.text)).toEqual(['Text was edited']);
  });
});

describe('mention autocomplete in the composer',()=>{
  const composer=(to='',onSend=vi.fn(async(..._args:any[])=>{}))=>{render(<AttachmentComposer members={members} to={to} onAddressee={()=>{}} focusToken={0}
    api={{uploadArtifact:vi.fn()} as any} onSend={onSend} ownerNames={{[members[1]!.principal_id]:['Fixture Person']}}/>);return onSend};
  const type=(field:HTMLTextAreaElement,value:string)=>{fireEvent.change(field,{target:{value,selectionStart:value.length}});field.setSelectionRange(value.length,value.length);fireEvent.select(field)};

  it('lists people and agents with their kind, inserts a structured mention, and sends its exact range',async()=>{
    const onSend=composer();
    const field=screen.getByRole('textbox',{name:'Message'}) as HTMLTextAreaElement;
    type(field,'Please @fix');
    const list=screen.getByRole('listbox',{name:'Mention someone in this room'});
    const options=within(list).getAllByRole('option');
    // Every name matches the typed start, so they are alphabetical; an agent says whose it is.
    expect(options.map(o=>o.textContent)).toEqual(['FFixture Agent OneFixture Person\'s agentAgent','FFixture Agent TwoAgent','FFixture PersonHuman']);
    fireEvent.keyDown(field,{key:'ArrowDown'});
    expect(options[1]).toHaveAttribute('aria-selected','true');
    fireEvent.keyDown(field,{key:'ArrowUp'});
    expect(options[0]).toHaveAttribute('aria-selected','true');
    fireEvent.keyDown(field,{key:'Enter'});
    expect(field.value).toBe('Please @Fixture Agent One ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    type(field,'Please @Fixture Agent One can you start?');
    fireEvent.keyDown(field,{key:'Enter'});
    await waitFor(()=>expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![0]).toBe('Please @Fixture Agent One can you start?');
    expect(onSend.mock.calls[0]![4]).toEqual([{principal_id:members[1]!.principal_id,start:7,end:25}]);
  });

  it('a hand-typed name is plain text, and a message sent to one participant carries no mentions',async()=>{
    const onSend=composer(members[2]!.principal_id);
    const field=screen.getByRole('textbox',{name:'Message'}) as HTMLTextAreaElement;
    type(field,'@Fixture');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    type(field,'@Fixture Agent One please');
    fireEvent.keyDown(field,{key:'Enter'});
    await waitFor(()=>expect(onSend).toHaveBeenCalledTimes(1));
    expect(onSend.mock.calls[0]![4]).toEqual([]);
  });
});

describe('unread state on Home',()=>{
  const own={companyId:'c-own',name:'Fixture Workspace',accessScope:'workspace' as const};
  const shared={companyId:'c-shared',name:'Elsewhere',accessScope:'room_only' as const};
  it('marks rooms that need attention in Your rooms and Shared rooms, and keeps quiet ones quiet',async()=>{
    const latest=(text:string,event_type='message.sent')=>({event_type,actor_display_name:'Fixture Agent One',actor_kind:'agent',text,created_at:new Date().toISOString(),room_seq:9});
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{
      const company=/companies\/([^/]+)\/(rooms|agents)/.exec(String(url));
      const rooms=company?.[1]==='c-own'
        ? [{room_id:'r1',name:'Busy Room',project_name:'Busy Room',unread_count:3,mention_count:1,action_count:1,latest:latest('Draft is ready')},
           {room_id:'r2',name:'Quiet Room',project_name:'Quiet Room',unread_count:0,mention_count:0,action_count:0,latest:null}]
        : [{room_id:'r3',name:'Shared Room',project_name:'Shared Room',unread_count:2,mention_count:0,action_count:0,latest:latest('Summary','task.completed')}];
      return new Response(JSON.stringify(company?.[2]==='agents'?{agents:[]}:{rooms}),{status:200,headers:{'content-type':'application/json'}});
    }));
    render(<Home workspace={own} memberships={[own,shared]} onNavigate={()=>{}}/>);
    const busy=await screen.findByRole('button',{name:'Busy Room, 3 unread, 1 mention, needs you'});
    // Name, count and time only: no message preview repeated on the card.
    expect(within(busy).queryByText(/Draft is ready/)).not.toBeInTheDocument();
    expect(within(busy).getByText('3')).toHaveClass('unread-badge');
    expect(within(busy).getByText('Needs you')).toBeInTheDocument();
    expect(busy).toHaveClass('has-unread');
    const quiet=screen.getByRole('button',{name:'Quiet Room'});
    expect(quiet).not.toHaveClass('has-unread');
    expect(within(quiet).queryByText('Needs you')).not.toBeInTheDocument();
    const sharedRoom=screen.getByRole('button',{name:'Shared Room, 2 unread'});
    expect(within(sharedRoom).getByText('2')).toHaveClass('unread-badge');
    expect(within(sharedRoom).queryByText(/Summary/)).not.toBeInTheDocument();
  });
});

describe('read receipts',()=>{
  it('counts people who read up to a message as seen, and agents only as delivered, never the sender',async()=>{
    const {receiptsFor}=await import('../apps/web/src/App');
    const positions=[
      {principal_id:'sender',display_name:'Fixture Sender',kind:'human' as const,last_read_seq:9,delivered_seq:null},
      {principal_id:'reader',display_name:'Fixture Reader',kind:'human' as const,last_read_seq:7,delivered_seq:null},
      {principal_id:'behind',display_name:'Fixture Behind',kind:'human' as const,last_read_seq:3,delivered_seq:null},
      {principal_id:'agent',display_name:'Fixture Agent One',kind:'agent' as const,last_read_seq:null,delivered_seq:8},
    ];
    const receipts=receiptsFor({room_seq:5},positions,'sender');
    expect(receipts.seen.map(p=>p.display_name)).toEqual(['Fixture Reader']);
    expect(receipts.delivered.map(p=>p.display_name)).toEqual(['Fixture Agent One']);
    expect(receiptsFor({room_seq:null},positions,'sender')).toEqual({seen:[],delivered:[]});
  });
});
