/**
 * Concatenate the baseline system prompt with selected pack bodies
 * (REV-AGENT-CORE-003).
 *
 * Pure — no I/O. Output shape:
 *   <baseline>
 *
 *   ---
 *
 *   <pack body 1>
 *
 *   ---
 *
 *   <pack body 2>
 *
 * Empty `packBodies` returns the baseline unchanged so the existing tech-
 * detected prompt is the default.
 */

export function composeSystemPrompt(
  baseline: string,
  packBodies: readonly string[],
): string {
  const nonEmpty = packBodies
    .map(b => b.trim())
    .filter(b => b.length > 0);
  if (nonEmpty.length === 0) return baseline;
  return [baseline.trimEnd(), ...nonEmpty]
    .filter(Boolean)
    .join('\n\n---\n\n');
}
