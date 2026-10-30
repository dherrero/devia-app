import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_THEME,
  THEME_STORAGE_KEY,
  applyTheme,
  resolveTheme,
  toggleTheme,
  type Theme,
} from './accent-palettes';

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
});

describe('theme helpers (HT-T-02)', () => {
  it('keeps DEFAULT_THEME pinned to light (violet family, light mode)', () => {
    expect(DEFAULT_THEME).toBe('light');
  });

  it.each<Theme>(['light', 'dark', 'navy', 'navy-dark'])(
    'applyTheme writes %s into <html data-theme> and localStorage',
    (theme) => {
      applyTheme(theme);
      expect(document.documentElement.getAttribute('data-theme')).toBe(theme);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe(theme);
    },
  );

  it.each<Theme>(['light', 'dark', 'navy', 'navy-dark'])(
    'resolveTheme round-trips through localStorage for %s',
    (theme) => {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
      expect(resolveTheme()).toBe(theme);
    },
  );

  it('resolveTheme falls back to light when the persisted value is unknown', () => {
    localStorage.setItem(THEME_STORAGE_KEY, 'sepia');
    expect(resolveTheme()).toBe(DEFAULT_THEME);
  });

  it('resolveTheme falls back to light when nothing is persisted', () => {
    expect(resolveTheme()).toBe(DEFAULT_THEME);
  });

  it('toggleTheme keeps the family - light <-> dark', () => {
    applyTheme('light');
    expect(toggleTheme()).toBe('dark');
    expect(toggleTheme()).toBe('light');
  });

  it('toggleTheme keeps the family - navy <-> navy-dark', () => {
    applyTheme('navy');
    expect(toggleTheme()).toBe('navy-dark');
    expect(toggleTheme()).toBe('navy');
  });
});
