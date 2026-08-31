import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The page an emailed sign-in link lands on.
 *
 * It is a courier: it reads the token out of the URL fragment and hands it to the Mac app. The
 * things worth proving are what it does *not* do — send the token anywhere, keep it in the
 * address bar, or load anything from a third party — because those are the ways a magic link
 * gets read by somebody other than its owner.
 *
 * The shipped file is the thing under test, not a copy of its logic: the page exposes its one
 * decision so it can be called directly.
 */
const page = readFileSync(resolve(process.cwd(), "apps/marketing/signin.html"), "utf8");

/**
 * Run the page's two scripts the way a browser would: the head script first, which is what takes
 * the token out of the URL, then the body script that hands it on. Running them in that order is
 * the point — the head one has to work before anything else on the page exists.
 */
function run(hash: string): { target: string | null; urlAfter: string } {
  const scripts = [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]!);
  if (scripts.length !== 2) throw new Error(`expected a head and a body script, found ${scripts.length}`);

  const location = { hash, pathname: "/signin", href: `https://app.example.com/signin${hash}` };
  const win: Record<string, unknown> = { location };
  const history = {
    replaceState: (_s: unknown, _t: unknown, url: string) => { location.hash = ""; location.href = url; },
  };
  const call = (body: string) =>
    // eslint-disable-next-line no-new-func
    new Function("window", "document", "URLSearchParams", "history", body)(
      win, undefined, URLSearchParams, history);

  call(scripts[0]!);   // head
  call(scripts[1]!);   // body
  const fn = win.__signInTarget as ((t: unknown) => string | null) | undefined;
  if (!fn) throw new Error("the page no longer exposes its decision");
  return { target: fn(win.__mpaiToken), urlAfter: location.href };
}

const targetFor = (hash: string) => run(hash).target;

describe("the sign-in landing page", () => {
  it("hands a fragment-carried token to the app over its own scheme", () => {
    expect(targetFor("#token=mpsi_abc123")).toBe("multiplayerai://auth?token=mpsi_abc123");
  });

  it("re-encodes the token rather than passing it through raw", () => {
    expect(targetFor("#token=a%2Bb")).toBe(`multiplayerai://auth?token=${encodeURIComponent("a+b")}`);
  });

  it("says the link is incomplete rather than opening the app with nothing", () => {
    expect(targetFor("")).toBeNull();
    expect(targetFor("#")).toBeNull();
    expect(targetFor("#other=1")).toBeNull();
  });

  /**
   * The reason the token is in the fragment at all. A page that fetched, beaconed, or embedded
   * anything would put the token — or the fact of the visit — in front of a third party.
   */
  it("transmits nothing and loads nothing from anywhere else", () => {
    expect(page).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket/);
    expect(page).not.toMatch(/<img\b|<script[^>]+\bsrc=|<link[^>]+href="https?:/i);
    // No form could post it, and no query string could carry it to the server.
    expect(page).not.toMatch(/<form\b/i);
  });

  /**
   * The host injects its own scripts into this page — Netlify adds one. The token must be out of
   * the URL before any of them can run, which means during head parsing, not at the end of the
   * body where execution order is somebody else's decision.
   */
  it("erases the token from the URL in the head, before any other script exists", () => {
    const head = page.slice(0, page.indexOf("</head>"));
    expect(head).toContain("history.replaceState");
    expect(run("#token=mpsi_abc123").urlAfter).toBe("/signin");
    expect(run("#token=mpsi_abc123").urlAfter).not.toContain("mpsi_abc123");
  });

  it("asks not to be indexed and not to leak a referrer", () => {
    expect(page).toMatch(/name="robots"\s+content="noindex/);
    expect(page).toMatch(/name="referrer"\s+content="no-referrer"/);
  });

  it("offers a way through when the scheme does not fire", () => {
    expect(page).toContain('id="open"');
    expect(page).toContain('id="fallback"');
  });
});
