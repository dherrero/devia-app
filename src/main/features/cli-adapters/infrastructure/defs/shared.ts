import type { RuntimeModelOption } from '../../domain/runtime-agent-def';

/**
 * Synthetic "use whatever the CLI is configured for" model option. Always
 * the first entry of every `fallbackModels` list so the user picker has a
 * sensible default that doesn't pass `--model` to the spawned CLI.
 */
export const DEFAULT_MODEL_OPTION: RuntimeModelOption = {
  id: 'default',
  label: 'Default (CLI config)',
};

/**
 * Parse one-id-per-line stdout from `<cli> models`, dedupe, and prepend
 * the synthetic default option. Used by opencode and any future CLI that
 * exposes its model catalog in the same shape.
 */
export function parseLineSeparatedModels(stdout: string): RuntimeModelOption[] {
  const ids = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'));
  const seen = new Set<string>();
  const out: RuntimeModelOption[] = [DEFAULT_MODEL_OPTION];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, label: id });
  }
  return out;
}

/**
 * Codex rejects some reasoning efforts on specific model families. We
 * clamp to a permitted value silently so a stale user preference doesn't
 * blow up the run.
 */
export function clampCodexReasoning(
  modelId: string | null | undefined,
  effort: string | null | undefined,
): string | null | undefined {
  if (!effort) return effort;
  const raw = String(modelId ?? '').trim();
  const id = raw.includes('/') ? raw.split('/').pop() ?? raw : raw;
  const isGpt5LateFamily =
    !id ||
    id === 'default' ||
    id.startsWith('gpt-5.2') ||
    id.startsWith('gpt-5.3') ||
    id.startsWith('gpt-5.4') ||
    id.startsWith('gpt-5.5');
  if (isGpt5LateFamily && effort === 'minimal') return 'low';
  if (id === 'gpt-5.1' && effort === 'xhigh') return 'high';
  if (id === 'gpt-5.1-codex-mini') {
    return effort === 'high' || effort === 'xhigh' ? 'high' : 'medium';
  }
  return effort;
}
