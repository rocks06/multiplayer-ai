/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,fireEvent,render,screen,waitFor,within} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {Home} from '../apps/web/src/Home';
import {RoomNotifications} from '../apps/web/src/RoomNotifications';

/**
 * An agent's own view, and how much a room may interrupt. Every name here is a fixture.
 */
const agent = {
  agent_id: 'a1', principal_id: 'p1', display_name: 'Fixture Agent', status: 'active' as const,
  owner_display_name: 'Fixture Owner',
  connector: {enrolled: true, presence: 'connected' as const, runtime_status: 'working', last_seen_at: '2026-09-17T10:00:00.000Z',
    room_id: 'r1', room_name: 'Fixture Room', session_status: 'connected', connected_at: '2026-09-17T09:00:00.000Z',
    disconnected_at: null, profile: 'fixture-profile', device: 'Fixture Machine'},
  rooms: [{room_id: 'r1', name: 'Fixture Room'}],
  runtime: {type: 'hermes', version: '0.21.0'},
  owners: [{principal_id: 'h1', display_name: 'Fixture Owner'}],
};
const workspace = {companyId: 'c1', name: 'Fixture Workspace', accessScope: 'workspace' as const};

const serve = (handler?: (url: string, init?: RequestInit) => unknown) =>
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    const custom = handler?.(path, init);
    if (custom !== undefined) return new Response(JSON.stringify(custom), {status: 200, headers: {'content-type': 'application/json'}});
    const body = /\/agents$/.test(path) ? {agents: [agent]} : {rooms: []};
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
  }));

afterEach(() => {cleanup(); vi.unstubAllGlobals()});

describe('an agent on Home', () => {
  it('opens its own view, with everything about where it runs, and nothing destructive on the row', async () => {
    serve();
    render(<Home workspace={workspace} memberships={[workspace]} onNavigate={() => {}}/>);
    const row = await screen.findByRole('button', {name: /Fixture Agent, Connected/});
    // Removing an agent no longer sits on a row somebody is scanning.
    expect(screen.queryByRole('button', {name: 'Remove agent'})).toBeNull();

    fireEvent.click(row);
    const sheet = await screen.findByRole('dialog', {name: 'Fixture Agent details'});
    const value = (label: string) => within(sheet).getByText(label).parentElement!.textContent;
    expect(value('State')).toContain('working now');
    expect(value('Current room')).toContain('Fixture Room');
    expect(value('Runtime')).toContain('Hermes · 0.21.0');
    expect(value('Local profile')).toContain('fixture-profile');
    expect(value('Device')).toContain('Fixture Machine');
    expect(value('Session')).toContain('Live since');
    expect(value('Last activity')).not.toContain('Never');
    expect(within(sheet).getByRole('link', {name: 'Reconnect'})).toHaveAttribute('href', 'multiplayerai://connect-runtime?agent=p1');
    expect(within(sheet).getByRole('button', {name: 'Remove agent'})).toBeInTheDocument();
  });

  it('disconnects without removing, and asks before removing', async () => {
    const calls: string[] = [];
    serve((url, init) => {
      if (/\/disconnect$/.test(url)) {calls.push(`${init?.method} ${url}`); return {agent_principal_id: 'p1', sessions_ended: 1}}
      if (init?.method === 'DELETE') {calls.push(`DELETE ${url}`); return {principal_id: 'p1', status: 'removed'}}
      return undefined;
    });
    render(<Home workspace={workspace} memberships={[workspace]} onNavigate={() => {}}/>);
    fireEvent.click(await screen.findByRole('button', {name: /Fixture Agent, Connected/}));
    const sheet = await screen.findByRole('dialog', {name: 'Fixture Agent details'});

    fireEvent.click(within(sheet).getByRole('button', {name: 'Disconnect'}));
    await waitFor(() => expect(calls).toEqual(['POST /v1/companies/c1/agents/p1/disconnect']));

    // Removing is the one thing that asks first, and it is not the same button.
    fireEvent.click(within(sheet).getByRole('button', {name: 'Remove agent'}));
    const confirmation = await screen.findByRole('alertdialog', {name: 'Remove Fixture Agent?'});
    expect(calls).toHaveLength(1);
    fireEvent.click(within(confirmation).getByRole('button', {name: 'Remove agent'}));
    await waitFor(() => expect(calls[1]).toBe('DELETE /v1/companies/c1/agents/p1'));
    await waitFor(() => expect(screen.queryByRole('dialog', {name: 'Fixture Agent details'})).toBeNull());
  });
});

describe('how much a room may interrupt', () => {
  it('shows the current level, offers the five, and saves the one chosen', async () => {
    const saved: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {saved.push(JSON.parse(String(init.body)).level); return new Response(String(init.body), {status: 200, headers: {'content-type': 'application/json'}})}
      return new Response(JSON.stringify({room_id: 'r1', level: 'direct_mentions'}), {status: 200, headers: {'content-type': 'application/json'}});
    }));
    render(<RoomNotifications companyId="c1" roomId="r1"/>);
    const button = await screen.findByRole('button', {name: /Notifications: Direct, mentions and Needs you/});

    fireEvent.click(button);
    const menu = await screen.findByRole('menu', {name: 'Notifications for this room'});
    expect(within(menu).getAllByRole('menuitemradio').map(item => item.querySelector('strong')?.textContent)).toEqual([
      'All activity', 'Direct, mentions and Needs you', 'Mentions only', 'Important only', 'Off',
    ]);
    expect(within(menu).getByRole('menuitemradio', {name: /Direct, mentions and Needs you/})).toHaveAttribute('aria-checked', 'true');
    // Unread is not a preference, and the menu says so.
    expect(within(menu).getByText(/Unread counts everything/)).toBeInTheDocument();

    fireEvent.click(within(menu).getByRole('menuitemradio', {name: /Mentions only/}));
    await waitFor(() => expect(saved).toEqual(['mentions']));
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    expect(await screen.findByRole('button', {name: /Notifications: Mentions only/})).toBeInTheDocument();
  });

  it('keeps the previous level and says so when saving fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Response(JSON.stringify({error: {code: 'forbidden', message: 'No'}}), {status: 403, headers: {'content-type': 'application/json'}})
      : new Response(JSON.stringify({room_id: 'r1', level: 'all'}), {status: 200, headers: {'content-type': 'application/json'}})));
    render(<RoomNotifications companyId="c1" roomId="r1"/>);
    fireEvent.click(await screen.findByRole('button', {name: /Notifications: All activity/}));
    fireEvent.click(within(await screen.findByRole('menu')).getByRole('menuitemradio', {name: /^Off/}));
    expect(await screen.findByRole('alert')).toHaveTextContent('That did not save');
    expect(screen.getByRole('button', {name: /Notifications: All activity/})).toBeInTheDocument();
  });
});
