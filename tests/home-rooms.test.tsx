/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Home,runtimeLabel} from '../apps/web/src/Home';
import {readFileSync} from 'node:fs';

/**
 * Where a room a person was invited into actually appears.
 *
 * Being invited to one room makes somebody a room-only member of that room's workspace, which
 * arrives as a second entry in their identity. Home read `companies[0]` and nothing else, so a
 * room joined in a browser could never show up in the app however many times it was relaunched —
 * it was in a workspace Home was not looking at. Which section a room belongs to is the server's
 * answer, from the access it granted, not a guess made here.
 */
describe('Home, across every workspace a person belongs to', () => {
  const own = {companyId: 'c-own', name: 'Acme', accessScope: 'workspace' as const};
  const invited = {companyId: 'c-other', name: "Someone else's", accessScope: 'room_only' as const};

  const roomsBy = (byCompany: Record<string, Array<{room_id: string; name: string}>>) =>
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const match = /\/v1\/companies\/([^/]+)\/(rooms|agents)/.exec(String(url));
      const body = match?.[2] === 'agents'
        ? {agents: []}
        : {rooms: (byCompany[match?.[1] ?? ''] ?? []).map(r => ({...r, project_name: r.name}))};
      return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
    }));

  beforeEach(() => localStorage.clear());
  afterEach(() => {cleanup(); vi.unstubAllGlobals()});

  const section = (name: RegExp) => screen.getByRole('heading', {name}).closest('section')!;

  it('hands off to adapter-neutral Detect Agent without creating an identity', async () => {
    roomsBy({'c-own': []});
    render(<Home workspace={own} memberships={[own]} onNavigate={() => {}}/>);
    fireEvent.click(await screen.findByRole('button', {name: 'Connect an existing agent'}));
    expect(screen.getByRole('link', {name: 'Detect Agent'})).toHaveAttribute('href', 'multiplayerai://connect-runtime');
    expect(screen.queryByRole('link', {name: 'Detect Hermes'})).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Agent name')).not.toBeInTheDocument();
    expect(vi.mocked(fetch).mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
  });

  it('shows an invited room under Shared rooms, not among your own', async () => {
    roomsBy({'c-own': [{room_id: 'r1', name: 'Launch'}], 'c-other': [{room_id: 'r2', name: 'TESTING #1'}]});
    render(<Home workspace={own} memberships={[own, invited]} onNavigate={() => {}}/>);

    expect(await screen.findByRole('heading', {name: /Your rooms/})).toBeVisible();
    expect(within(section(/Your rooms/)).getByText('Launch')).toBeVisible();
    expect(within(section(/Shared rooms/)).getByText('TESTING #1')).toBeVisible();
    // Not duplicated across the two.
    expect(within(section(/Your rooms/)).queryByText('TESTING #1')).toBeNull();
  });

  it('opens an invited room in the workspace it actually belongs to', async () => {
    roomsBy({'c-own': [], 'c-other': [{room_id: 'r2', name: 'TESTING #1'}]});
    const went: string[] = [];
    render(<Home workspace={own} memberships={[own, invited]} onNavigate={to => went.push(to)}/>);

    (await screen.findByText('TESTING #1')).closest('button')!.click();
    // The other workspace's id, not the signed-in person's own — a room needs both to open.
    expect(went).toEqual(['/rooms/c-other/r2']);
  });

  it('says so plainly when nobody has shared anything', async () => {
    roomsBy({'c-own': [{room_id: 'r1', name: 'Launch'}]});
    render(<Home workspace={own} memberships={[own]} onNavigate={() => {}}/>);

    await screen.findByRole('heading', {name: /Shared rooms/});
    expect(within(section(/Shared rooms/)).getByText(/Rooms other people invite you into/)).toBeVisible();
  });

  /** Agents are workspace-scoped, so a room-only membership must not be asked for them. */
  it('never asks a room-only workspace for its agents', async () => {
    roomsBy({'c-own': [], 'c-other': [{room_id: 'r2', name: 'TESTING #1'}]});
    render(<Home workspace={own} memberships={[own, invited]} onNavigate={() => {}}/>);
    await screen.findByText('TESTING #1');

    const asked = vi.mocked(fetch).mock.calls.map(([url]) => String(url));
    expect(asked.some(url => url.includes('/c-own/agents'))).toBe(true);
    expect(asked.some(url => url.includes('/c-other/agents'))).toBe(false);
  });
});

/** Choosing agents for a new room: one aligned row per agent, box and name together. */
describe('Create room agent selection', () => {
  const own = {companyId: 'c-own', name: 'Workspace', accessScope: 'workspace' as const};
  const fixtureAgents = [
    {agent_id: 'a1', principal_id: 'p1', display_name: 'Fixture Agent One', status: 'active', owner_display_name: null, rooms: [],
     connector: {enrolled: true, presence: 'connected', runtime_status: 'idle', last_seen_at: null, room_id: null, room_name: null},
     runtime: {type: 'hermes', version: '0.21.0'}},
    {agent_id: 'a2', principal_id: 'p2', display_name: 'Fixture Agent Two', status: 'active', owner_display_name: null, rooms: [],
     connector: {enrolled: false, presence: 'never', runtime_status: null, last_seen_at: null, room_id: null, room_name: null},
     runtime: null},
  ];
  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const body = /\/agents/.test(String(url)) ? {agents: fixtureAgents} : {rooms: []};
      return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
    }));
  });
  afterEach(() => {cleanup(); vi.unstubAllGlobals()});

  it('puts each checkbox and its agent name in one row, with runtime detail only when known', async () => {
    render(<Home workspace={own} memberships={[own]} onNavigate={() => {}}/>);
    fireEvent.click((await screen.findAllByRole('button', {name: /Create room/}))[0]!);
    const group = await screen.findByRole('group', {name: 'Which agents belong here?'});
    const rows = within(group).getAllByRole('checkbox').map(box => box.closest('label')!);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText('Fixture Agent One')).toBeInTheDocument();
    expect(within(rows[0]!).getByText('Hermes · 0.21.0')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('Fixture Agent Two')).toBeInTheDocument();
    expect(rows[1]!.querySelector('small')).toBeNull();
    // Box and name are one control: its accessible name is the agent's.
    const box = within(group).getByRole('checkbox', {name: /Fixture Agent One/});
    fireEvent.click(within(rows[0]!).getByText('Fixture Agent One'));
    expect(box).toBeChecked();
  });

  it('never stretches a checkbox with the form\'s full-width field rule', () => {
    const css = readFileSync('apps/web/src/styles.css', 'utf8');
    expect(css).toMatch(/\.home-form input:not\(\[type=checkbox\]\),\.home-form textarea\{width:100%/);
    expect(css).not.toMatch(/\.home-form input,\.home-form textarea\{width:100%/);
    expect(runtimeLabel({runtime: {type: 'hermes', version: null}})).toBe('Hermes');
    expect(runtimeLabel({runtime: {type: 'other-runtime', version: '2'}})).toBe('other-runtime · 2');
    expect(runtimeLabel({runtime: null})).toBeNull();
  });
});
