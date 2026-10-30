import { Injectable, computed, signal } from '@angular/core';
import { applyTheme, resolveTheme } from './accent-palettes';
import {
  familyModeToTheme,
  themeToFamilyMode,
  type ThemeFamily,
  type ThemeMode,
} from './models/theme-option.model';

/**
 * Single mutation entry point for the two-axis theme model (HT-T-03).
 *
 * State:
 * - `family` — `'violet' | 'navy'`
 * - `mode`   — `'light' | 'dark'`
 *
 * DOM contract (`setTheme` keeps these in lockstep with the signals):
 * - Persisted `Theme` string in `localStorage('devia.theme')` and on
 *   `<html data-theme>` — handled by `applyTheme()` from accent-palettes.ts.
 * - Accent colors come from the active libs/styles theme tokens.
 *
 * Hydration: the constructor reads the legacy `Theme` value persisted by
 * the pre-bootstrap script in `index.html` (HT-T-02) and exposes the
 * decomposed (family, mode) without re-touching the DOM — the inline
 * script already painted the correct state. `AppStateService.loadConfig`
 * keeps calling `applyTheme(resolveTheme())` as its authoritative apply,
 * so the service does not race with it.
 */
@Injectable({ providedIn: 'root' })
export class ThemeService {
  private readonly _family = signal<ThemeFamily>('violet');
  private readonly _mode = signal<ThemeMode>('light');

  readonly family = this._family.asReadonly();
  readonly mode = this._mode.asReadonly();
  readonly isDark = computed(() => this._mode() === 'dark');

  constructor() {
    const { family, mode } = themeToFamilyMode(resolveTheme());
    this._family.set(family);
    this._mode.set(mode);
  }

  /** Set both axes at once and propagate to DOM + localStorage. */
  setTheme(family: ThemeFamily, mode: ThemeMode): void {
    this._family.set(family);
    this._mode.set(mode);
    applyTheme(familyModeToTheme(family, mode));
  }

  setFamily(family: ThemeFamily): void {
    this.setTheme(family, this._mode());
  }

  setMode(mode: ThemeMode): void {
    this.setTheme(this._family(), mode);
  }

  /** Convenience for keyboard/menu actions: flips light↔dark within the
   *  current family. */
  toggleMode(): void {
    this.setMode(this._mode() === 'dark' ? 'light' : 'dark');
  }
}
