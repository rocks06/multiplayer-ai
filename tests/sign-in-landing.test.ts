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

/** Run the page's inline script the way a browser would, without a DOM to draw into. */
function targetFor(hash: string): string | null {
  const script = page.slice(page.indexOf("<script>") + 8, page.lastIndexOf("</script>"));
  const scope: Record<string, unknown> = {
    window: { location: { hash: "" } } as Record<string, unknown>,
    document: undefined,
    URLSearchParams,
    history: undefined,
  };
  // eslint-disable-next-line no-new-func
  new Function("window", "document", "URLSearchParams", "history", script)(
    scope.window, undefined, URLSearchParams, undefined);
  const fn = (scope.window as { __signInTarget?: (h: string) => string | null }).__signInTarget;
  if (!fn) throw new Error("the page no longer exposes its decision");
  return fn(hash);
}

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

  it("takes the token out of the address bar once it has been used", () => {
    expect(page).toContain("history.replaceState");
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
