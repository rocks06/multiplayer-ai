/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen,within} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {Home} from '../apps/web/src/Home';

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
