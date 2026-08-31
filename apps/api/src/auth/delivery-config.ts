import { LoggingSignInLinkDelivery, SilentSignInLinkDelivery, type SignInLinkDelivery } from "./auth-service.js";
import { ResendSignInLinkDelivery } from "./resend-delivery.js";
import { buildSignInLink } from "./sign-in-link.js";

/**
 * Choosing how sign-in links reach people, from the environment, at startup.
 *
 * The one rule worth stating: asking for real email and not being able to send it is a failure,
 * not a reason to quietly write links to a log file. A deployment that silently downgraded would
 * appear to work — accounts created, "check your email" shown — while every link went to a
 * console nobody reads and the addresses waited forever.
 *
 * Pure, and given its environment rather than reading one, so every branch can be checked
 * without setting a variable on the machine running the tests.
 */
export type DeliveryMode = "resend" | "logging" | "silent";

export interface DeliveryEnvironment {
  SIGN_IN_DELIVERY?: string;
  RESEND_API_KEY?: string;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_REPLY_TO?: string;
  PUBLIC_APP_URL?: string;
}

export class DeliveryConfigurationError extends Error {}

const present = (value: string | undefined) => typeof value === "string" && value.trim().length > 0;

/** What the app will actually do, named so the product can say the right thing about it. */
export function deliveryMode(environment: DeliveryEnvironment): DeliveryMode {
  const chosen = (environment.SIGN_IN_DELIVERY ?? "").trim().toLowerCase();
  if (chosen === "resend") return "resend";
  if (chosen === "silent") return "silent";
  return "logging";
}

export function resolveSignInDelivery(
  environment: DeliveryEnvironment,
  overrides: { fetch?: typeof globalThis.fetch; log?: (line: string) => void } = {},
): SignInLinkDelivery {
  switch (deliveryMode(environment)) {
    case "silent":
      return new SilentSignInLinkDelivery();

    case "logging":
      return new LoggingSignInLinkDelivery(overrides.log);

    case "resend": {
      const missing = (["RESEND_API_KEY", "AUTH_EMAIL_FROM", "PUBLIC_APP_URL"] as const)
        .filter(name => !present(environment[name]));
      if (missing.length) {
        // Names only. The values are the secret, and this message goes to a console.
        throw new DeliveryConfigurationError(
          `SIGN_IN_DELIVERY=resend needs ${missing.join(", ")}. Set them, or choose a different SIGN_IN_DELIVERY.`);
      }
      const publicAppUrl = environment.PUBLIC_APP_URL!.trim();
      try {
        // Proving the link can be built at all, before the first person is told to check an inbox.
        buildSignInLink(publicAppUrl, "startup-probe");
      } catch (failure) {
        throw new DeliveryConfigurationError(`PUBLIC_APP_URL is not usable: ${(failure as Error).message}`);
      }
      return new ResendSignInLinkDelivery({
        apiKey: environment.RESEND_API_KEY!.trim(),
        from: environment.AUTH_EMAIL_FROM!.trim(),
        replyTo: present(environment.AUTH_EMAIL_REPLY_TO) ? environment.AUTH_EMAIL_REPLY_TO!.trim() : undefined,
        publicAppUrl,
        fetch: overrides.fetch,
        log: overrides.log,
      });
    }
  }
}
