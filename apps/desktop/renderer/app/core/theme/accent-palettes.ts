export const THEME_STORAGE_KEY = 'devia.theme';

/**
 * Theme key persisted in `localStorage('devia.theme')` and applied as
 * `<html data-theme="...">`. Two families x two modes:
 * - `light`     - violet family, light mode (default)
 * - `dark`      - violet family, dark mode
 * - `navy`      - navy family, light mode
 * - `navy-dark` - navy family, dark mode
 *
 * Family selection itself is driven by HT-T-03 (`ThemeService`). Accent colors
 * come directly from libs/styles tokens for each theme.
 */
export type Theme = 'light' | 'dark' | 'navy' | 'navy-dark';
export const DEFAULT_THEME: Theme = 'light';

const THEME_VALUES: ReadonlySet<Theme> = new Set<Theme>(['light', 'dark', 'navy', 'navy-dark']);

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && THEME_VALUES.has(value as Theme);
}

export function resolveTheme(): Theme {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return isTheme(v) ? v : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch { /* ignore */ }
}

/** Family-preserving toggle: light<->dark, navy<->navy-dark. */
export function toggleTheme(): Theme {
  const TOGGLE: Readonly<Record<Theme, Theme>> = {
    light: 'dark',
    dark: 'light',
    navy: 'navy-dark',
    'navy-dark': 'navy',
  };
  const next = TOGGLE[resolveTheme()];
  applyTheme(next);
  return next;
}

export const STYLE_STORAGE_KEY = 'devia.style';
export const DEFAULT_STYLE: 'rounded' | 'sharp' = 'rounded';

export function resolveStyle(): 'rounded' | 'sharp' {
  try {
    const v = localStorage.getItem(STYLE_STORAGE_KEY);
    return v === 'sharp' ? 'sharp' : 'rounded';
  } catch {
    return DEFAULT_STYLE;
  }
}

export function applyStyle(style: 'rounded' | 'sharp'): void {
  if (style === 'sharp') {
    document.documentElement.setAttribute('data-style', 'sharp');
  } else {
    document.documentElement.removeAttribute('data-style');
  }
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, style);
  } catch { /* ignore */ }
}
