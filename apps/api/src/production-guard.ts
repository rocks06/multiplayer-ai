/**
 * Configuration that must never reach a public origin.
 *
 * These are not preferences. Each one is a setting that is correct on a laptop and a total
 * failure on the internet, and each is a single character in an environment variable. A
 * deployment that got one wrong would look entirely healthy — it serves, it signs people in, the
 * tests pass — while being wide open. Checked at startup so a mistake is a refusal to boot
 * rather than something discovered afterwards.
 *
 * Pure, so every branch can be exercised without setting a variable on the machine running them.
 */
export interface DeploymentEnvironment {
  DEPLOYMENT_ENV?: string;
  ALLOW_HEADER_PRINCIPAL?: string;
  AUTH_COOKIE_SECURE?: string;
  /** Hands an authenticated caller somebody else's sign-in token. Local deployments only. */
  MPAI_OPERATOR_SIGN_IN_LINKS?: string;
  /** Where the process listens. A non-loopback bind is how a laptop setting reaches a network. */
  HOST?: string;
  /** Set by Render on every service it runs; present means this is a hosted origin. */
  RENDER?: string;
  RENDER_EXTERNAL_URL?: string;
}

export class ProductionConfigurationError extends Error {}

const enabled = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";

/** A deployment that has said, in so many words, that it is somebody's own machine. */
const DECLARED_LOCAL = new Set(["development", "dev", "local", "test"]);
const LOOPBACK = new Set(["", "127.0.0.1", "::1", "localhost"]);

/**
 * Whether these settings must hold to production standards.
 *
 * It used to mean one variable spelled exactly right. A hosted deployment that never set it, or
 * set it to "prod", was therefore exempt from every check meant to protect it — the failure mode
 * being precisely the one nobody would notice, because everything works. It now fails closed: a
 * hosted origin or a non-loopback bind is treated as production unless the environment declares
 * itself local by name. Saying `DEPLOYMENT_ENV=development` is how a laptop on a LAN opts out,
 * which is a deliberate statement rather than an omission.
 */
export const isProduction = (environment: DeploymentEnvironment) => {
  const declared = (environment.DEPLOYMENT_ENV ?? "").trim().toLowerCase();
  if (DECLARED_LOCAL.has(declared)) return false;
  // Anything else somebody wrote on purpose — "production", "prod", "staging" — is not a laptop.
  if (declared) return true;
  if ((environment.RENDER ?? "").trim().toLowerCase() === "true") return true;
  if ((environment.RENDER_EXTERNAL_URL ?? "").trim()) return true;
  return !LOOPBACK.has((environment.HOST ?? "").trim().toLowerCase());
};

/**
 * Everything wrong with this environment for a public deployment, named. All of them, not just
 * the first: being told about one problem, fixing it, and being told about the next is a worse
 * way to learn what a deployment needs.
 */
export function productionProblems(environment: DeploymentEnvironment): string[] {
  if (!isProduction(environment)) return [];
  const problems: string[] = [];

  if (enabled(environment.ALLOW_HEADER_PRINCIPAL)) {
    // It accepts a caller-supplied x-principal-id *and* re-opens the unauthenticated company and
    // human bootstrap routes. On a public origin that is not a weakened check, it is no check.
    problems.push(
      "ALLOW_HEADER_PRINCIPAL is enabled. It lets any caller name the principal they are acting as, "
      + "and re-opens the unauthenticated bootstrap routes. Remove it from this environment.");
  }

  if (environment.AUTH_COOKIE_SECURE === "0") {
    // Without Secure the session cookie travels over plain HTTP, and anything between the person
    // and the server can lift it. It exists so a laptop can be used over http://localhost.
    problems.push(
      "AUTH_COOKIE_SECURE=0 would issue session cookies that are not marked Secure. "
      + "Remove it from this environment; it is only for local development over plain HTTP.");
  }

  if (enabled(environment.MPAI_OPERATOR_SIGN_IN_LINKS)) {
    // It returns another person's single-use sign-in token to whoever asks for it, which is that
    // person's account. It exists for a laptop with no email transport and nowhere else.
    problems.push(
      "MPAI_OPERATOR_SIGN_IN_LINKS is enabled. It hands an authenticated caller another person's "
      + "sign-in token, which is their account. Remove it from this environment.");
  }

  return problems;
}

export function assertProductionSafe(environment: DeploymentEnvironment): void {
  const problems = productionProblems(environment);
  if (!problems.length) return;
  throw new ProductionConfigurationError(problems.map(problem => `• ${problem}`).join("\n  "));
}
