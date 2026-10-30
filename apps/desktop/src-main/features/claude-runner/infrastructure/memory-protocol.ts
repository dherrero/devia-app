/**
 * Devia internal memory protocol (S-1).
 *
 * Appended to the system prompt as an extra "pack body" (sharing the same `---`
 * divider treatment as prompt packs) ONLY when `config.memory.enabled`. It
 * tells the agent that Devia exposes its own persistent memory via the
 * `devia-memory` MCP server and how to use the `mem_*` tools. Adapted from
 * engram's protocol but scoped to Devia's own server, so it stays useful even
 * when the external engram MCP is blocked for the run.
 */
export const MEMORY_PROTOCOL = [
  '## Devia persistent memory (devia-memory MCP)',
  '',
  'Persists across sessions and compactions. Use it proactively — do not wait to be asked. The `mem_save` field shapes (type/scope/topic_key/content) are documented in the tool schema.',
  '',
  '- SAVE (`mem_save`) the moment it happens: architecture/design decisions, fixed bugs (with root cause), conventions/patterns/workflows, non-obvious discoveries or gotchas, user preferences/constraints. Record a noteworthy user request with `mem_save_prompt`.',
  '- SEARCH before work that may already exist, or whenever asked to recall (in any language): `mem_context` (recent, cheap) → `mem_search` (keywords) → `mem_get_observation` (full content by id).',
  '- CLOSE each session with `mem_session_summary` (goal, discoveries, accomplished, next steps, files) — skipping it leaves the next session blind.',
].join('\n');

/**
 * Returns the memory protocol body when memory is enabled, else null so the
 * caller omits it from the composed system prompt.
 */
export function buildMemoryProtocolHint(enabled: boolean): string | null {
  return enabled ? MEMORY_PROTOCOL : null;
}
