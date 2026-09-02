/**
 * Turning a single-use token into something a person can click.
 *
 * Kept apart from both the delivery and the authentication so the shape of the link can be
 * decided, and checked, without a mail provider or a database in the way. Nothing here knows
 * what the token means; it only knows how to carry it.
 */

/** Where the raw token is carried, which is a security decision rather than a formatting one. */
export type Carrier = "fragment" | "query";

export interface LinkTarget {
  /** Where a sign-in link points. An https origin, or a custom scheme the app has registered. */
  publicAppUrl: string;
}

const CUSTOM_SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Build the link that goes in the email.
 *
 * An https destination carries the token in the **fragment**, not the query string. A fragment is
 * never sent to the server, so the page that receives it can hand the token to the app without
 * the token ever reaching a web host's logs — and a corporate link scanner that fetches the URL
 * ahead of the recipient cannot see it, let alone spend it. A single-use token in a query string
 * is routinely burned before its owner ever clicks.
 *
 * A custom-scheme destination has no server to hide anything from, so it uses a query, which is
 * what the app's own URL handling already reads.
 */
export function buildSignInLink(
  publicAppUrl: string, token: string, returnTo?: SignInReturn,
): string {
  /* Where signing in began decides where it must finish.

     A person who started in a browser — following a room invitation, with the invite secret held
     in that tab — has to come back to that tab, authenticated. Sending them to the page that hands
     tokens to the Mac app instead spends the single-use token somewhere their browser will never
     hear about, and the invitation they were in the middle of accepting is simply lost. It is not
     a redirect that went astray; the session was established in the wrong place entirely.

     So a web return is built against the origin the browser is already on, which is also the
     origin that serves the invitation. Everything else keeps the existing destination. */
  const base = (returnTo?.kind === "web" ? returnTo.origin : publicAppUrl).trim().replace(/\/+$/, "");
  const encoded = encodeURIComponent(token);
  if (/^https?:\/\//i.test(base)) return `${base}/signin#token=${encoded}`;
  if (CUSTOM_SCHEME.test(base)) return `${base}?token=${encoded}`;
  throw new Error("PUBLIC_APP_URL must be an http(s) URL or a custom scheme such as multiplayerai://auth");
}

/**
 * Which context asked for this link, stated rather than guessed.
 *
 * There is no way to infer it after the fact: a link built for the Mac app and a link built for a
 * browser were identical, so one of the two flows was always going to be wrong. The app is the
 * default because that is the long-standing behaviour, and only a caller that knows it is a
 * browser says so.
 */
export type SignInReturn =
  | { kind: "app" }
  | { kind: "web"; origin: string };

/** Which half of the link carries the token, for the tests and for anyone reasoning about it. */
export function carrierOf(publicAppUrl: string): Carrier {
  return /^https?:\/\//i.test(publicAppUrl.trim()) ? "fragment" : "query";
}

/**
 * A link with the token taken out, safe to put in a log.
 *
 * The whole point of a magic link is that possession of the URL is possession of the account, so
 * the URL is exactly as secret as the token inside it. Anything written down keeps the shape and
 * loses the secret.
 */
export function redactLink(link: string): string {
  return link
    .replace(/([#?&]token=)[^&\s]+/gi, "$1…redacted")
    .replace(/\bmpsi_[A-Za-z0-9_-]+/g, "mpsi_…redacted");
}
