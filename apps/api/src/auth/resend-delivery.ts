import type { SignInLink, SignInLinkDelivery } from "./auth-service.js";
import { buildSignInLink, redactLink } from "./sign-in-link.js";

/**
 * Sending sign-in links as real email, through Resend's HTTPS API.
 *
 * The API key is held here and never leaves: it is not logged, not echoed in an error, and not
 * part of anything this returns. Neither is the token — the link is built, handed to the
 * provider, and forgotten. What can be written down is that a send failed and what the provider
 * said about it, which is what an operator actually needs.
 *
 * No SDK. One POST with a JSON body is the whole integration, and a dependency that wraps it
 * would have to be trusted with the same key.
 */
export interface ResendOptions {
  apiKey: string;
  from: string;
  replyTo?: string;
  publicAppUrl: string;
  /** Injected in tests. Production uses the platform's own fetch. */
  fetch?: typeof globalThis.fetch;
  log?: (line: string) => void;
  endpoint?: string;
}

const ENDPOINT = "https://api.resend.com/emails";

export class ResendSignInLinkDelivery implements SignInLinkDelivery {
  constructor(private readonly options: ResendOptions) {}

  async deliver(link: SignInLink): Promise<void> {
    const url = buildSignInLink(this.options.publicAppUrl, link.token);
    const send = this.options.fetch ?? globalThis.fetch;
    const log = this.options.log ?? ((line: string) => console.log(line));

    const response = await send(this.options.endpoint ?? ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.options.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: this.options.from,
        to: [link.email],
        ...(this.options.replyTo ? { reply_to: this.options.replyTo } : {}),
        subject: "Sign in to Multiplayer AI",
        text: plainText(url),
        html: html(url),
      }),
    });

    if (!response.ok) {
      // Whatever the provider said, minus anything that could carry the token. The address stays:
      // this is a server-side operational log, and an operator cannot chase a bounce without it.
      const detail = await response.text().catch(() => "");
      log(`[auth] sign-in email to ${link.email} was not accepted (${response.status}): ${redactLink(detail).slice(0, 300)}`);
      throw new Error(`Sign-in email was not accepted (${response.status})`);
    }
    /* The provider's own id for the message. Not a secret, and the only thing that makes a
       delivery answerable afterwards: without it "we sent it" is a claim nobody can check
       against the provider's own record of what happened to it. */
    const accepted = (await response.json().catch(() => ({}))) as { id?: string };
    log(`[auth] sign-in email accepted for delivery to ${link.email}${accepted.id ? ` (${accepted.id})` : ""}`);
  }
}

/**
 * The email.
 *
 * Minimal on purpose: one sentence of context, one button, one honest line about what to do if it
 * was not you. No images, no tracking pixel, no click wrapper — a sign-in link that phones a
 * third party on open is a sign-in link that has been shown to somebody else.
 */
function plainText(url: string): string {
  return [
    "Sign in to Multiplayer AI",
    "",
    "Use this link to sign in:",
    url,
    "",
    "The link expires in 15 minutes and can be used once.",
    "If you did not ask to sign in, you can ignore this email — nothing will happen.",
  ].join("\n");
}

function html(url: string): string {
  const href = escapeAttribute(url);
  return `<!doctype html>
<html lang="en">
<body style="margin:0;padding:0;background:#f7f8f6;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f8f6;">
    <tr><td align="center" style="padding:40px 20px;">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:440px;background:#ffffff;border:1px solid #dfe3de;border-radius:10px;">
        <tr><td style="padding:32px 32px 28px 32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#171a17;">
          <p style="margin:0 0 22px 0;font-size:11px;letter-spacing:1.4px;font-weight:600;color:#8a938c;">MULTIPLAYER AI</p>
          <h1 style="margin:0 0 10px 0;font-size:22px;line-height:1.25;font-weight:500;color:#171a17;">Sign in to Multiplayer AI</h1>
          <p style="margin:0 0 26px 0;font-size:15px;line-height:1.5;color:#667069;">Use the button below to finish signing in.</p>
          <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:7px;background:#171a17;">
            <a href="${href}" style="display:inline-block;padding:12px 22px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;font-weight:500;color:#f7f8f6;text-decoration:none;border-radius:7px;">Continue to Multiplayer AI</a>
          </td></tr></table>
          <p style="margin:26px 0 0 0;font-size:13px;line-height:1.5;color:#667069;">This link expires in 15 minutes and can be used once.</p>
          <p style="margin:8px 0 0 0;font-size:13px;line-height:1.5;color:#8a938c;">If you did not ask to sign in, ignore this email — nothing will happen.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
