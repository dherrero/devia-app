/**
 * Two-axis theme model introduced by HT-T-03.
 *
 * - **Family** picks the visual identity: `violet` (default Devia look,
 *   rounded corners, lavender accent) or `navy` (angular corners, teal
 *   accent — see `docs/od-design/NAVY-THEME-SPEC.md`).
 * - **Mode** picks `light` or `dark` within that family.
 *
 * The four combinations map 1:1 to the persisted `Theme` string written to
 * `<html data-theme>` and `localStorage('devia.theme')` (see HT-T-02):
 *
 *   `violet-light` → `light`
 *   `violet-dark`  → `dark`
 *   `navy-light`   → `navy`
 *   `navy-dark`    → `navy-dark`
 *
 * `ThemeService.setTheme(family, mode)` is the single mutation entry point
 * so DOM and localStorage stay in sync.
 */

import type { Theme } from '../accent-palettes';

export type ThemeFamily = 'violet' | 'navy';
export type ThemeMode = 'light' | 'dark';

const THEME_TO_FAMILY_MODE: Readonly<Record<Theme, { family: ThemeFamily; mode: ThemeMode }>> = {
  light:       { family: 'violet', mode: 'light' },
  dark:        { family: 'violet', mode: 'dark' },
  navy:        { family: 'navy',   mode: 'light' },
  'navy-dark': { family: 'navy',   mode: 'dark' },
};

/** Decompose the persisted single-string `Theme` into the (family, mode) axes. */
export function themeToFamilyMode(theme: Theme): { family: ThemeFamily; mode: ThemeMode } {
  return THEME_TO_FAMILY_MODE[theme];
}

/** Compose (family, mode) back into the persisted single-string `Theme`. */
export function familyModeToTheme(family: ThemeFamily, mode: ThemeMode): Theme {
  if (family === 'navy') return mode === 'dark' ? 'navy-dark' : 'navy';
  return mode === 'dark' ? 'dark' : 'light';
}
