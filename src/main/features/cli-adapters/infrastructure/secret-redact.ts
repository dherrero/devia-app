/**
 * Console-log secret redaction for the DEV launch dump.
 *
 * A value is masked when its KEY looks like a secret (API keys, access keys,
 * tokens, passwords, credentials). Masking keeps only the last 2 characters and
 * replaces the rest with asterisks (capped at 12 so a long token doesn't print
 * an absurd run) — enough to confirm "a value is set" and eyeball its tail
 * without leaking it. Non-secret keys are printed verbatim.
 */
const SECRET_KEY_RE = /(API_?KEY|ACCESS_KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

export function maskSecretValue(value: string): string {
  if (value.length <= 2) return '*'.repeat(value.length);
  const stars = Math.min(value.length - 2, 12);
  return '*'.repeat(stars) + value.slice(-2);
}

/** Format an env map for a single DEV log line, masking secret-looking values. */
export function redactEnvForLog(env: Record<string, string>): string {
  const entries = Object.entries(env);
  if (entries.length === 0) return '(none)';
  return entries
    .map(([k, v]) => `${k}=${isSecretKey(k) ? maskSecretValue(v) : v}`)
    .join(' ');
}
