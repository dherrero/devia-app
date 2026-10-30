/**
 * Compact rendering of an agent token count for the statusbar (HT-C-03).
 *
 * Anchored on the OpenDesign mockup
 * (`docs/od-design/ds-desktop-00-full-violet-light.png` → `28.1k / 200k`):
 * the `k` band keeps one decimal of precision when it carries information
 * and drops it when the result is a clean integer.
 *
 * - `0 … 999`           → integer, no suffix          (`"512"`)
 * - `1_000 … 999_999`   → up to one decimal + `k`     (`"1.5k"`, `"28.1k"`, `"200k"`)
 * - `1_000_000+`        → up to one decimal + `M`     (`"1.2M"`, `"2M"`)
 *
 * Negatives clamp to `0` — token counts are intrinsically non-negative and
 * mishandled IPC values shouldn't render as `"-12k"`. NaN / non-finite
 * passes through as `"—"` so the statusbar never paints garbage.
 */
export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const n = Math.max(0, Math.floor(value));
  if (n < 1000) return String(n);
  if (n < 1_000_000) return trimDecimal((n / 1000).toFixed(1)) + 'k';
  return trimDecimal((n / 1_000_000).toFixed(1)) + 'M';
}

function trimDecimal(formatted: string): string {
  return formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted;
}
