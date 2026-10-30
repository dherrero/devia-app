/**
 * Pure helpers for passive memory capture (E-DSK-13, phase C).
 *
 * The runner sees the full turn (user prompt, tool_use events, exit code) so it
 * can persist memory without relying on the agent to call `mem_*` itself —
 * mirroring engram's UserPromptSubmit / Stop hooks. These helpers only sanitise
 * and format; the actual persistence is delegated to the memory feature via
 * injected callbacks.
 */

/** Default cap for a persisted user prompt. */
const PROMPT_MAX_CHARS = 2_000;
/** The prompt excerpt embedded in an auto run summary stays short. */
const SUMMARY_PROMPT_CHARS = 280;

/**
 * Strip user-marked secrets and common credential shapes from text (E-DSK-13
 * #315). Used both on capture (so secrets never reach the store) AND on
 * injection (so anything already stored — or saved by the agent — is never
 * echoed back into a prompt, possibly to a different provider). Conservative:
 * only `<private>` regions, well-known token formats, and `key=value`-style
 * secret assignments are redacted, to avoid mangling ordinary prose.
 */
const PRIVATE_RE = /<private>[\s\S]*?<\/private>/gi;
const SECRET_RES: readonly RegExp[] = [
  /\bsk-[A-Za-z0-9]{16,}\b/g, // OpenAI-style keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\blt_[A-Za-z0-9_]{20,}\b/g, // Leantime-style keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, // Authorization: Bearer <token>
];
const SECRET_ASSIGNMENT_RE =
  /\b(api[_-]?key|secret|token|password|passwd|access[_-]?key|auth(?:orization)?)\b(\s*[:=]\s*)(["']?)[^\s"']{6,}\3/gi;

export function redactSensitive(text: string): string {
  let out = text.replace(PRIVATE_RE, '[REDACTED]');
  for (const re of SECRET_RES) out = out.replace(re, '[REDACTED]');
  out = out.replace(SECRET_ASSIGNMENT_RE, (_m, key: string, sep: string) => `${key}${sep}[REDACTED]`);
  return out;
}

/**
 * Redact secrets (see {@link redactSensitive}) and clamp length, so a huge
 * paste never bloats memory. Used on the capture path; the injection path
 * (`memory-context-hint`) redacts too.
 */
export function sanitizeForMemory(text: string, maxChars: number = PROMPT_MAX_CHARS): string {
  const stripped = redactSensitive(text).trim();
  if (stripped.length <= maxChars) return stripped;
  return stripped.slice(0, Math.max(0, maxChars - 1)).trimEnd() + '…';
}

/**
 * Build a one-line auto summary for a completed run. Kept terse on purpose: the
 * agent's own `mem_session_summary` (when it follows the protocol) produces the
 * rich entries; this is the passive fallback that records that *something*
 * happened, so the next session is not blind even if the agent saved nothing.
 */
export function buildRunSummary(
  prompt: string,
  toolCount: number,
  code: number | null,
): string {
  const head = sanitizeForMemory(prompt, SUMMARY_PROMPT_CHARS).replace(/\s+/g, ' ');
  const status = code === 0 ? 'completed' : `exited ${code ?? 'unknown'}`;
  const calls = `${toolCount} tool call${toolCount === 1 ? '' : 's'}`;
  return `Auto-captured run: "${head}" — ${calls}, ${status}.`;
}
