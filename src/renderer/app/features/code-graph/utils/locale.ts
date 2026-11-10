import type { TranslateService } from '@ngx-translate/core';

/** The UI language drives number/date formatting so counters match the translated text around them. */
export function uiLocale(translate: TranslateService): string | undefined {
  return translate.currentLang || translate.defaultLang || undefined;
}
