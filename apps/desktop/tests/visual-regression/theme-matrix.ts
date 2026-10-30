import type { Page } from '@playwright/test';

/**
 * Canonical themes shipped by the desktop renderer (HT-T-01..04).
 *
 * Each entry knows how to coerce `<html>` into the matching state so a
 * Playwright spec can iterate through `THEMES` without re-implementing
 * the data-attribute juggling.
 */
export interface ThemeMatrixEntry {
  readonly key: 'violet-light' | 'violet-dark' | 'navy-light' | 'navy-dark';
  readonly label: string;
  /** `data-theme` attribute value applied to `<html>`. */
  readonly dataTheme: 'light' | 'dark' | 'navy' | 'navy-dark';
}

export const THEMES: readonly ThemeMatrixEntry[] = [
  { key: 'violet-light', label: 'Violet Light', dataTheme: 'light' },
  { key: 'violet-dark',  label: 'Violet Dark',  dataTheme: 'dark' },
  { key: 'navy-light',   label: 'Navy Light',   dataTheme: 'navy' },
  { key: 'navy-dark',    label: 'Navy Dark',    dataTheme: 'navy-dark' },
];

/** Apply a theme to the page under test. */
export async function applyTheme(page: Page, entry: ThemeMatrixEntry): Promise<void> {
  await page.evaluate(
    ({ dataTheme }) => {
      document.documentElement.setAttribute('data-theme', dataTheme);
      // Disable any in-flight animations that started before the theme
      // flipped; the global reduce-motion guard takes care of new ones.
      for (const el of Array.from(document.querySelectorAll('*'))) {
        (el as HTMLElement).style.animation = 'none';
      }
    },
    { dataTheme: entry.dataTheme },
  );
}
