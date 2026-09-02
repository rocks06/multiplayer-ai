/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from 'vitest';
import { rememberAcross } from '../apps/web/src/pending-invite';

/**
 * What has to survive the trip to an email client.
 *
 * A magic link is opened from Mail, which means a new tab. Everything the invitation flow had put
 * in `sessionStorage` — the invite secret, and where to return afterwards — was invisible there,
 * so the tab that came back authenticated had no idea it had been joining a room. The person
 * signed in successfully and landed on Home.
 */
describe('what a browser remembers while its owner fetches an email', () => {
  const KEY = 'mpai:pending-room-invite';
  /** A new tab is the same origin with its own, empty sessionStorage. */
  const newTab = () => sessionStorage.clear();

  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); });

  it('is still there in the tab the link opens', () => {
    rememberAcross.write(KEY, 'invite-secret');
    newTab();
    expect(rememberAcross.read(KEY)).toBe('invite-secret');
  });

  it('is gone once it has been used', () => {
    rememberAcross.write(KEY, 'invite-secret');
    rememberAcross.forget(KEY);
    newTab();
    expect(rememberAcross.read(KEY)).toBeNull();
  });

  /** An invitation abandoned in a browser must not wait there indefinitely to be resumed. */
  it('expires rather than waiting forever', () => {
    localStorage.setItem(KEY, JSON.stringify({ value: 'stale', at: Date.now() - 2 * 60 * 60 * 1000 }));
    expect(rememberAcross.read(KEY)).toBeNull();
    // And it clears itself out rather than being re-read every time.
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  /** A tab mid-flight when this shipped wrote a bare string; it still has to work. */
  it('reads what the previous per-tab version wrote', () => {
    sessionStorage.setItem(KEY, 'written-by-the-old-build');
    expect(rememberAcross.read(KEY)).toBe('written-by-the-old-build');
  });

  /** Private browsing throws on write. Losing the handoff is bad; crashing the page is worse. */
  it('survives a storage that refuses', () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() { throw new Error('denied'); },
    });
    expect(() => rememberAcross.write(KEY, 'x')).not.toThrow();
    expect(() => rememberAcross.read(KEY)).not.toThrow();
    if (real) Object.defineProperty(globalThis, 'localStorage', real);
  });
});
