/**
 * Pure helpers used by the sidebar to render project / session metadata.
 * Kept in `utils/` so they're testable without Angular DI.
 */

/** Last segment of a workspace-relative path. */
export function leafOf(path: string): string {
  return path.split('/').pop() ?? path;
}

/** Project subline (`branch · N msgs`). Pieces are optional and joined
 *  with the project's bullet separator so an empty git state collapses
 *  cleanly. Live values are passed in from the caller; this helper does
 *  not reach into any service. */
export function projectSubline(input: {
  branch?: string | null;
  dirty?: boolean;
  msgs?: number;
}): string {
  const parts: string[] = [];
  if (input.branch) {
    parts.push(input.dirty ? `${input.branch} ●` : input.branch);
  }
  if ((input.msgs ?? 0) > 0) parts.push(`${input.msgs} msgs`);
  return parts.join(' · ');
}

/**
 * Session timestamp formatter used in the Sesiones list.
 *
 * - Same year as today  → `"23 oct · 14:30"`
 * - Different year      → `"23 oct 2024"` (no time, year carries enough)
 *
 * Locale comes from the active i18n; `0` / falsy renders empty so a
 * pristine session reads cleanly.
 */
export function formatSessionDate(
  ts: number,
  locale: string,
  now: Date = new Date(),
): string {
  if (!ts) return '';
  const d = new Date(ts);
  const day = d.getDate();
  const month = d.toLocaleString(locale, { month: 'short' }).replace('.', '');
  const time = d.toTimeString().slice(0, 5);
  return d.getFullYear() === now.getFullYear()
    ? `${day} ${month} · ${time}`
    : `${day} ${month} ${d.getFullYear()}`;
}
