import { describe, expect, it } from "vitest";
import {
  LoggingSignInLinkDelivery,
  SilentSignInLinkDelivery,
  type SignInLink,
} from "../apps/api/src/auth/auth-service.js";
import { ResendSignInLinkDelivery } from "../apps/api/src/auth/resend-delivery.js";
import {
  DeliveryConfigurationError,
  deliveryMode,
  resolveSignInDelivery,
} from "../apps/api/src/auth/delivery-config.js";
import { buildSignInLink, carrierOf, redactLink } from "../apps/api/src/auth/sign-in-link.js";

const TOKEN = "mpsi_ThIsIsNotARealToken-0123456789_abcdefg";
const KEY = "re_not_a_real_key_0123456789";
const link = (): SignInLink => ({
  user_id: "u1",
  email: "someone@example.com",
  token: TOKEN,
  expires_at: new Date(Date.now() + 15 * 60_000).toISOString(),
});

/** A fetch that records the one call it is given and answers however the test says. */
function recorder(response: { ok: boolean; status?: number; body?: string } = { ok: true }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetch = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return {
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 422),
      text: async () => response.body ?? "",
    } as Response;
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body));

describe("the link that goes in the email", () => {
  /**
   * The token rides in the fragment, which is never sent to a server.
   *
   * A single-use token in a query string reaches the web host that serves the page and every
   * corporate link scanner that fetches the URL before its owner does — and a scanner that
   * follows a query-string magic link spends it. In the fragment there is nothing for either to
   * see.
   */
  it("carries the token where no server can read it", () => {
    const url = buildSignInLink("https://app.example.com", TOKEN);
    expect(url).toBe(`https://app.example.com/signin#token=${encodeURIComponent(TOKEN)}`);
    expect(new URL(url).search).toBe("");
    expect(carrierOf("https://app.example.com")).toBe("fragment");
  });

  it("uses a query when the destination is the app itself, which has no server to hide from", () => {
    expect(buildSignInLink("multiplayerai://auth", TOKEN)).toBe(`multiplayerai://auth?token=${encodeURIComponent(TOKEN)}`);
    expect(carrierOf("multiplayerai://auth")).toBe("query");
  });

  it("encodes the token rather than trusting its alphabet", () => {
    expect(buildSignInLink("https://app.example.com", "a+b/c=d")).toContain("token=a%2Bb%2Fc%3Dd");
  });

  it("does not care about a trailing slash", () => {
    expect(buildSignInLink("https://app.example.com/", TOKEN)).toBe(buildSignInLink("https://app.example.com", TOKEN));
  });

  it("refuses a destination that is not a URL at all", () => {
    expect(() => buildSignInLink("app.example.com", TOKEN)).toThrow(/PUBLIC_APP_URL/);
  });

  /** A magic link is exactly as secret as the token inside it. */
  it("can be written down only with the secret taken out", () => {
    const redacted = redactLink(buildSignInLink("https://app.example.com", TOKEN));
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain("app.example.com");
  });
});

describe("sending through Resend", () => {
  it("addresses the person who asked, from the configured sender, with the reply-to", async () => {
    const { calls, fetch } = recorder();
    await new ResendSignInLinkDelivery({
      apiKey: KEY, from: "Multiplayer AI <sign-in@auth.webpulseaudit.com>",
      replyTo: "rocco@webpulseaudit.com", publicAppUrl: "https://app.example.com",
      fetch, log: () => {},
    }).deliver(link());

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.resend.com/emails");
    const body = bodyOf(calls[0]!);
    expect(body.to).toEqual(["someone@example.com"]);
    expect(body.from).toBe("Multiplayer AI <sign-in@auth.webpulseaudit.com>");
    expect(body.reply_to).toBe("rocco@webpulseaudit.com");
    expect(body.subject).toBe("Sign in to Multiplayer AI");
  });

  it("puts the real sign-in link in both the button and the plain-text part", async () => {
    const { calls, fetch } = recorder();
    await new ResendSignInLinkDelivery({
      apiKey: KEY, from: "a@b.c", publicAppUrl: "https://app.example.com", fetch, log: () => {},
    }).deliver(link());
    const body = bodyOf(calls[0]!);
    const expected = `https://app.example.com/signin#token=${encodeURIComponent(TOKEN)}`;
    expect(body.text).toContain(expected);
    expect(body.html).toContain(`href="${expected}"`);
    expect(body.html).toContain("Continue to Multiplayer AI");
    expect(body.text).toContain("15 minutes");
    expect(body.text).toContain("ignore this email");
  });

  it("omits reply-to entirely rather than sending an empty one", async () => {
    const { calls, fetch } = recorder();
    await new ResendSignInLinkDelivery({
      apiKey: KEY, from: "a@b.c", publicAppUrl: "https://app.example.com", fetch, log: () => {},
    }).deliver(link());
    expect(bodyOf(calls[0]!)).not.toHaveProperty("reply_to");
  });

  /** Nothing that opens the email may tell anyone else that it was opened. */
  it("carries no tracking pixel or click wrapper", async () => {
    const { calls, fetch } = recorder();
    await new ResendSignInLinkDelivery({
      apiKey: KEY, from: "a@b.c", publicAppUrl: "https://app.example.com", fetch, log: () => {},
    }).deliver(link());
    const body = bodyOf(calls[0]!);
    expect(body.html).not.toMatch(/<img/i);
    // The only link in the message is the sign-in link itself.
    expect([...String(body.html).matchAll(/href="([^"]*)"/g)].map(m => m[1]))
      .toEqual([`https://app.example.com/signin#token=${encodeURIComponent(TOKEN)}`]);
  });

  it("sends the key as a bearer token and nowhere else", async () => {
    const { calls, fetch } = recorder();
    await new ResendSignInLinkDelivery({
      apiKey: KEY, from: "a@b.c", publicAppUrl: "https://app.example.com", fetch, log: () => {},
    }).deliver(link());
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${KEY}`);
    expect(String(calls[0]!.init.body)).not.toContain(KEY);
    expect(calls[0]!.url).not.toContain(KEY);
  });

  /**
   * The two things that must never be written down, checked on the paths that write things down:
   * a successful send, and a failure carrying whatever the provider said back.
   */
  it("never logs the token, the link, or the key — on success or on failure", async () => {
    const lines: string[] = [];
    const options = {
      apiKey: KEY, from: "a@b.c", replyTo: "r@b.c",
      publicAppUrl: "https://app.example.com", log: (line: string) => lines.push(line),
    };

    await new ResendSignInLinkDelivery({ ...options, fetch: recorder().fetch }).deliver(link());
    // A provider that echoes the request back at us must not turn a failure into a leak.
    const echo = recorder({ ok: false, status: 422, body: JSON.stringify({ message: `rejected ${TOKEN}` }) });
    await expect(new ResendSignInLinkDelivery({ ...options, fetch: echo.fetch }).deliver(link()))
      .rejects.toThrow(/not accepted/);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain(KEY);
      expect(line).not.toContain("#token=");
    }
  });

  it("reports a refusal as a failure rather than pretending it was sent", async () => {
    const { fetch } = recorder({ ok: false, status: 403, body: "forbidden" });
    await expect(new ResendSignInLinkDelivery({
      apiKey: KEY, from: "a@b.c", publicAppUrl: "https://app.example.com", fetch, log: () => {},
    }).deliver(link())).rejects.toThrow(/403/);
  });
});

describe("choosing a delivery at startup", () => {
  const complete = {
    SIGN_IN_DELIVERY: "resend",
    RESEND_API_KEY: KEY,
    AUTH_EMAIL_FROM: "Multiplayer AI <sign-in@auth.webpulseaudit.com>",
    AUTH_EMAIL_REPLY_TO: "rocco@webpulseaudit.com",
    PUBLIC_APP_URL: "https://app.example.com",
  };

  it("builds a Resend delivery when everything it needs is there", () => {
    expect(resolveSignInDelivery(complete)).toBeInstanceOf(ResendSignInLinkDelivery);
    expect(deliveryMode(complete)).toBe("resend");
  });

  /**
   * The failure that matters most. A deployment that asked for real email and quietly fell back
   * to a log file would look entirely healthy — accounts created, "check your email" shown — while
   * every link went somewhere nobody reads.
   */
  it.each(["RESEND_API_KEY", "AUTH_EMAIL_FROM", "PUBLIC_APP_URL"] as const)(
    "refuses to start without %s rather than falling back to logging", missing => {
      const environment = { ...complete, [missing]: "" };
      expect(() => resolveSignInDelivery(environment)).toThrow(DeliveryConfigurationError);
      try { resolveSignInDelivery(environment); } catch (failure) {
        expect((failure as Error).message).toContain(missing);
        // Names, never values.
        expect((failure as Error).message).not.toContain(KEY);
      }
    });

  it("refuses a PUBLIC_APP_URL it could never build a link from", () => {
    expect(() => resolveSignInDelivery({ ...complete, PUBLIC_APP_URL: "app.example.com" }))
      .toThrow(DeliveryConfigurationError);
  });

  it("treats a missing reply-to as optional, not as a failure", () => {
    expect(() => resolveSignInDelivery({ ...complete, AUTH_EMAIL_REPLY_TO: "" })).not.toThrow();
  });

  it("keeps the development log delivery, but only when it is asked for by name", () => {
    expect(resolveSignInDelivery({ SIGN_IN_DELIVERY: "logging" })).toBeInstanceOf(LoggingSignInLinkDelivery);
    expect(resolveSignInDelivery({})).toBeInstanceOf(LoggingSignInLinkDelivery);
    expect(deliveryMode({})).toBe("logging");
  });

  it("still writes the link where a developer can find it", async () => {
    const lines: string[] = [];
    await resolveSignInDelivery({ SIGN_IN_DELIVERY: "logging" }, { log: line => lines.push(line) })
      .deliver(link());
    expect(lines.join("\n")).toContain(TOKEN);
  });

  it("keeps a delivery that sends nothing, for automated tests", async () => {
    const silent = resolveSignInDelivery({ SIGN_IN_DELIVERY: "silent" });
    expect(silent).toBeInstanceOf(SilentSignInLinkDelivery);
    await expect(silent.deliver(link())).resolves.toBeUndefined();
  });
});
