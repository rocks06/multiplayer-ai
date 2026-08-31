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
}

export class ProductionConfigurationError extends Error {}

const enabled = (value: string | undefined) => value === "1" || value?.toLowerCase() === "true";

export const isProduction = (environment: DeploymentEnvironment) =>
  (environment.DEPLOYMENT_ENV ?? "").trim().toLowerCase() === "production";

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

  return problems;
}

export function assertProductionSafe(environment: DeploymentEnvironment): void {
  const problems = productionProblems(environment);
  if (!problems.length) return;
  throw new ProductionConfigurationError(problems.map(problem => `• ${problem}`).join("\n  "));
}
