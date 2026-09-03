/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import {cleanup,render,screen,waitFor} from '@testing-library/react';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import JoinRoom from '../apps/web/src/JoinRoom';

/**
 * What happens after somebody accepts an invitation.
 *
 * It used to drop them straight into the browser, and the room then existed only there — opening
 * the Mac app afterwards showed no sign of it. The room is worked in the app, so the app is
 * offered; the browser stays available for anyone who cannot or would rather not.
 */
describe('joining a shared room, and where it continues', () => {
  const company = '00000000-0000-4000-8000-0000000000c1';
  const room = '00000000-0000-4000-8000-0000000000r2'.replace('r', '0');
  const preview = {room_name: 'TESTING #1', company_name: 'Acme'};

  const backend = () => vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = String(url).includes('/auth/me')
      ? {user: {id: 'u1', email: 'b@example.com', display_name: 'B'}, companies: []}
      : String(url).includes('/room-invites/preview')
        ? preview
        : {company_id: company, room_id: room, principal_id: 'p1',
           room_name: preview.room_name, company_name: preview.company_name,
           room_path: `/rooms/${company}/${room}`};
    return new Response(JSON.stringify(body), {status: 200, headers: {'content-type': 'application/json'}});
  }));

  beforeEach(() => {
    history.replaceState({}, '', '/join#invite-secret-value-long-enough');
    localStorage.clear(); sessionStorage.clear();
    backend();
  });
  afterEach(() => {cleanup(); vi.unstubAllGlobals(); localStorage.clear()});

  it('offers the app, and keeps the browser available', async () => {
    render(<JoinRoom navigate={() => {}}/>);
    expect(await screen.findByRole('heading', {name: 'TESTING #1'})).toBeVisible();
    expect(screen.getByRole('button', {name: 'Open in Multiplayer AI'})).toBeVisible();
    expect(screen.getByRole('button', {name: /Continue in this browser/})).toBeVisible();
  });

  /** Membership exists server-side now, so nothing may still be holding the secret. */
  it('forgets the invite secret once it has been redeemed', async () => {
    render(<JoinRoom navigate={() => {}}/>);
    await screen.findByRole('button', {name: 'Open in Multiplayer AI'});

    const held = JSON.stringify([
      ...Object.entries(localStorage), ...Object.entries(sessionStorage),
    ]);
    expect(held).not.toContain('invite-secret-value-long-enough');
    // And it is out of the address bar, so the URL cannot be replayed or shared.
    expect(location.hash).toBe('');
  });

  /** Only the two ids travel to the app; the secret is spent and has no business being there. */
  it('hands the app the room, not the invitation', async () => {
    render(<JoinRoom navigate={() => {}}/>);
    const open = await screen.findByRole('button', {name: 'Open in Multiplayer AI'});

    const went: string[] = [];
    const real = Object.getOwnPropertyDescriptor(window, 'location');
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: new Proxy(location, {set: (_t, key, value) => {
        if (key === 'href') went.push(String(value));
        return true;
      }}),
    });
    open.click();
    // Put it back, or the next test inherits a window that cannot navigate.
    if (real) Object.defineProperty(window, 'location', real);

    expect(went).toHaveLength(1);
    expect(went[0]).toBe(`multiplayerai://room?company=${company}&room=${room}`);
    expect(went[0]).not.toContain('invite-secret');
  });

  /** A Mac with no app must not be left looking at a button that did nothing. */
  it('says so, and offers the download, when nothing opens', async () => {
    // The page staying focused is the only evidence available that nothing handled the link;
    // jsdom reports no focus at all, so it is stated here.
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    render(<JoinRoom navigate={() => {}}/>);
    (await screen.findByRole('button', {name: 'Open in Multiplayer AI'})).click();
    // Nothing took the focus away, which is the only evidence a browser can offer that no
    // application handled the link.
    const note = await screen.findByRole('status', {}, {timeout: 4000});
    expect(note).toHaveTextContent(/did not open/i);
    expect(screen.getByRole('link', {name: /Download it/})).toHaveAttribute('href', '/download');
  });
});
