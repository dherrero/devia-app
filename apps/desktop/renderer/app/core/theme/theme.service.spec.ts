import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { THEME_STORAGE_KEY } from './accent-palettes';
import { ThemeService } from './theme.service';

function makeService(): ThemeService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [ThemeService],
  });
  return TestBed.inject(ThemeService);
}

function htmlTheme(): string | null {
  return document.documentElement.getAttribute('data-theme');
}

describe('ThemeService (HT-T-03)', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
  });

  describe('hydration from persisted Theme', () => {
    it('starts on violet-light when nothing is persisted', () => {
      const svc = makeService();
      expect(svc.family()).toBe('violet');
      expect(svc.mode()).toBe('light');
      expect(svc.isDark()).toBe(false);
    });

    it('hydrates violet-dark from persisted `dark`', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      const svc = makeService();
      expect(svc.family()).toBe('violet');
      expect(svc.mode()).toBe('dark');
      expect(svc.isDark()).toBe(true);
    });

    it('hydrates navy-light from persisted `navy`', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'navy');
      const svc = makeService();
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('light');
    });

    it('hydrates navy-dark from persisted `navy-dark`', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'navy-dark');
      const svc = makeService();
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('dark');
    });

    it('does NOT re-touch the DOM at construction (anti-flash script already painted it)', () => {
      localStorage.setItem(THEME_STORAGE_KEY, 'dark');
      makeService();
      expect(document.documentElement.getAttribute('data-theme')).toBeNull();
    });
  });

  describe('setTheme', () => {
    it('writes data-theme=dark for (violet, dark)', () => {
      const svc = makeService();
      svc.setTheme('violet', 'dark');
      expect(htmlTheme()).toBe('dark');
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');
    });

    it('writes data-theme=light for (violet, light)', () => {
      const svc = makeService();
      svc.setTheme('violet', 'light');
      expect(htmlTheme()).toBe('light');
    });

    it('writes data-theme=navy for (navy, light)', () => {
      const svc = makeService();
      svc.setTheme('navy', 'light');
      expect(htmlTheme()).toBe('navy');
    });

    it('writes data-theme=navy-dark for (navy, dark)', () => {
      const svc = makeService();
      svc.setTheme('navy', 'dark');
      expect(htmlTheme()).toBe('navy-dark');
    });

    it('keeps signals consistent after a series of switches', () => {
      const svc = makeService();
      svc.setTheme('navy', 'dark');
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('dark');
      svc.setTheme('violet', 'light');
      expect(svc.family()).toBe('violet');
      expect(svc.mode()).toBe('light');
      expect(svc.isDark()).toBe(false);
    });
  });

  describe('setFamily / setMode / toggleMode', () => {
    it('setFamily preserves the current mode', () => {
      const svc = makeService();
      svc.setTheme('violet', 'dark');
      svc.setFamily('navy');
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('dark');
    });

    it('setMode preserves the current family', () => {
      const svc = makeService();
      svc.setTheme('navy', 'light');
      svc.setMode('dark');
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('dark');
    });

    it('toggleMode flips light ↔ dark within violet family', () => {
      const svc = makeService();
      svc.setTheme('violet', 'light');
      svc.toggleMode();
      expect(svc.family()).toBe('violet');
      expect(svc.mode()).toBe('dark');
      svc.toggleMode();
      expect(svc.family()).toBe('violet');
      expect(svc.mode()).toBe('light');
    });

    it('toggleMode flips light ↔ dark within navy family', () => {
      const svc = makeService();
      svc.setTheme('navy', 'light');
      svc.toggleMode();
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('dark');
      svc.toggleMode();
      expect(svc.family()).toBe('navy');
      expect(svc.mode()).toBe('light');
    });
  });
});
