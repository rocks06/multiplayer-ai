/**
 * What a browser has to remember while its owner goes to fetch an email.
 *
 * A magic link is opened from a mail client, which means a **new tab**. `sessionStorage` is
 * per-tab, so everything the invitation flow had put there — the invite secret and where to
 * return — was invisible to the tab that actually came back authenticated. The person signed in
 * successfully and landed on Home, with no sign that they had been joining a room at all.
 *
 * localStorage is shared across tabs of one origin, which is exactly the handoff needed. The
 * secret still never leaves the browser: it is not in the email, not in a query string, and not
 * sent anywhere but the accept call it was always destined for.
 *
 * It expires regardless. An invitation abandoned in a browser should not still be sitting there
 * days later waiting to be resumed by whoever next opens that laptop.
 */
const TTL_MS = 60 * 60 * 1000;

interface Held { value: string; at: number }

/* Reaching for the store is itself what throws.

   A browser with site data blocked does not hand back a null localStorage — it throws on the
   property access. Naming both stores in an array evaluates both before any `try` can catch it,
   which turns a degraded storage into a blank page. Each one is therefore fetched inside its own
   attempt, and a store that cannot be reached is simply one that holds nothing. */
const stores = ['localStorage', 'sessionStorage'] as const;
const storeNamed = (name: (typeof stores)[number]): Storage | null => {
  try { return globalThis[name] ?? null; } catch { return null; }
};

const read = (key: string): string | null => {
  for (const name of stores) {
    try {
      const store = storeNamed(name);
      const raw = store?.getItem(key);
      if (!raw) continue;
      // Anything written by the previous per-tab version is a bare string, and still usable.
      if (!raw.startsWith('{')) return raw;
      const held = JSON.parse(raw) as Held;
      if (Date.now() - held.at > TTL_MS) { store!.removeItem(key); continue; }
      return held.value;
    } catch { /* a blocked or full store is not a reason to fail the flow */ }
  }
  return null;
};

const write = (key: string, value: string) => {
  const held: Held = { value, at: Date.now() };
  try { storeNamed('localStorage')?.setItem(key, JSON.stringify(held)); } catch { /* private mode */ }
};

const forget = (key: string) => {
  for (const name of stores) {
    try { storeNamed(name)?.removeItem(key); } catch { /* nothing to do about it */ }
  }
};

export const rememberAcross = { read, write, forget };
