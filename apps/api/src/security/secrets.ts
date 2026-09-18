/**
 * Recognising a secret without keeping it.
 *
 * Only shapes that are unambiguous: our own credential prefixes, private-key blocks, and provider
 * key formats whose prefixes cannot plausibly be ordinary prose. A pattern that fires on normal
 * writing would teach people to ignore it, so anything short of near-certain is left to later
 * data-loss work rather than guessed at here.
 *
 * What is returned is the *kind* of secret found, never the text — callers log and report kinds,
 * and nothing matched ever leaves this function.
 */
const SECRET_PATTERNS: ReadonlyArray<{ kind: string; pattern: RegExp }> = [
  { kind: "multiplayer_agent_credential", pattern: /\bmagc_[A-Za-z0-9_-]{20,}/ },
  { kind: "multiplayer_agent_session", pattern: /\bmags_[A-Za-z0-9_-]{20,}/ },
  { kind: "multiplayer_user_session", pattern: /\bmpss_[A-Za-z0-9_-]{20,}/ },
  { kind: "multiplayer_sign_in_link", pattern: /\bmpsi_[A-Za-z0-9_-]{20,}/ },
  { kind: "multiplayer_room_invite", pattern: /\bmpri_[A-Za-z0-9_-]{20,}/ },
  { kind: "private_key", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/ },
  { kind: "openssh_private_key", pattern: /-----BEGIN OPENSSH PRIVATE KEY-----/ },
  { kind: "aws_access_key", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: "github_token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { kind: "slack_token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { kind: "stripe_secret_key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { kind: "anthropic_api_key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { kind: "openai_api_key", pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{32,}\b/ },
  { kind: "google_api_key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: "json_web_token", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Which kinds of secret a text contains. Never the secrets themselves. */
export function secretKinds(text: string | null | undefined): string[] {
  if (!text) return [];
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ kind }) => kind);
}

/** The same text with anything secret-shaped replaced, for places that must keep the rest. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const { pattern, kind } of SECRET_PATTERNS) {
    result = result.replace(new RegExp(pattern.source, "g"), `[redacted ${kind}]`);
  }
  return result;
}
