import { inject, Injectable, computed, effect } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { AppStateService } from '../services/app-state.service';
import {
  detectSystemLanguage,
  isSupportedLanguage,
  resolveLanguage,
} from './supported-languages';

/**
 * Single source of truth for the UI language.
 *
 * Precedence (highest first):
 *   1. Explicit user choice persisted in `cfg.language`
 *   2. OS / browser locale (`navigator.language`)
 *   3. {@link DEFAULT_LANGUAGE}
 *
 * Persistence is one-way: as soon as the user picks something from the
 * Settings dropdown we write `language` to `devia-app.config.json`, and
 * from that point on detection is bypassed — user intent always wins.
 */
@Injectable({ providedIn: 'root' })
export class I18nService {
  private readonly translate = inject(TranslateService);
  private readonly state = inject(AppStateService);

  /** What language the UI is currently showing. Reads the persisted
   *  preference if any, otherwise falls back to OS detection. Exposed as a
   *  signal so the Settings dropdown can bind to it without manual sync. */
  readonly currentLanguage = computed<string>(() => {
    const cfg = this.state.config();
    const persisted = cfg?.language;
    if (persisted && isSupportedLanguage(persisted)) return persisted;
    return detectSystemLanguage();
  });

  constructor() {
    effect(() => {
      const lang = this.currentLanguage();
      if (this.translate.currentLang !== lang) {
        this.translate.use(lang);
      }
    });
  }

  /** Persist the user's explicit choice and apply it immediately. Any
   *  value not in the supported list is normalised down to a known code so
   *  a stale config can't strand the UI on a missing translation file. */
  setLanguage(lang: string) {
    const resolved = resolveLanguage(lang);
    this.translate.use(resolved);
    this.state.saveConfig({ language: resolved });
  }

  getCurrentLanguage(): string {
    return this.currentLanguage();
  }
}
