/**
 * Catalogue of UI languages shipped with the app, plus OS-locale detection.
 *
 * Each entry maps to a `renderer/assets/i18n/<code>.json` file that
 * `ngx-translate` loads on demand via `TranslateHttpLoader`. The list is
 * the single source of truth for the Settings dropdown (rendered with the
 * native label so a Chinese user sees "简体中文" instead of "Chinese").
 *
 * `detectSystemLanguage()` is called twice: once at bootstrap so the
 * `TranslateModule.defaultLanguage` matches the OS before any UI paints,
 * and again from `I18nService` when the user's config has no explicit
 * `language` field (fresh install, never opened Settings).
 *
 * User intent always wins: once the user picks a language in Settings,
 * `language` is persisted in `devia-app.config.json` and detection is
 * skipped on subsequent launches.
 */
export interface SupportedLanguage {
  /** ngx-translate code + JSON filename (without extension). */
  code: string;
  /** Endonym shown in the Settings dropdown. */
  nativeLabel: string;
}

/**
 * Languages offered in Settings. All eleven — same set the download site
 * advertises, which is the promise this list has to keep.
 *
 * INCOMPLETE, and knowingly so (S-27). Measured 2026-08-01 against `en.json`
 * (819 keys): the nine languages other than es/en sit at ~67.5%, each missing
 * 265-267 keys. That matters more than usual here because this app does NOT
 * fall back to English — `@ngx-translate` renders the raw key path, so a
 * missing key shows up as `sdd.event.task_done` inside the UI.
 *
 * They stay offered anyway because the gap is NOT spread evenly. The everyday
 * surface is translated (chat 27/33, sidebar 56/64, diff viewer, tool cards
 * and ui_tools at 100%); the holes are concentrated in later features — the
 * SDD kanban (66 of 68 missing), the MCP manager (27 of 29) and the sub-agents
 * modal (24 of 26). A German user gets a mostly-German app with raw keys in
 * three specific modals, which beats being handed English instead.
 *
 * S-27 closes the gap in batches and adds the parity gate that stops it
 * reopening. Do not add a language here without a complete file.
 */
export const SUPPORTED_LANGUAGES: readonly SupportedLanguage[] = [
  { code: 'es', nativeLabel: 'Español' },
  { code: 'en', nativeLabel: 'English' },
  { code: 'ca', nativeLabel: 'Valencià' },
  { code: 'fr', nativeLabel: 'Français' },
  { code: 'de', nativeLabel: 'Deutsch' },
  { code: 'it', nativeLabel: 'Italiano' },
  { code: 'pt', nativeLabel: 'Português' },
  { code: 'ru', nativeLabel: 'Русский' },
  { code: 'zh', nativeLabel: '简体中文' },
  { code: 'hi', nativeLabel: 'हिन्दी' },
  { code: 'ar', nativeLabel: 'العربية' },
];

export const DEFAULT_LANGUAGE = 'en';

const SUPPORTED_CODES = new Set(SUPPORTED_LANGUAGES.map((l) => l.code));

/** Pick the closest supported language for an arbitrary BCP-47 tag.
 *  Tries exact match first ("zh"), then the primary subtag ("zh-CN" → "zh"),
 *  then falls back to {@link DEFAULT_LANGUAGE}. */
export function resolveLanguage(tag: string | null | undefined): string {
  if (!tag) return DEFAULT_LANGUAGE;
  const normalized = tag.toLowerCase();
  if (SUPPORTED_CODES.has(normalized)) return normalized;
  const primary = normalized.split(/[-_]/)[0];
  if (SUPPORTED_CODES.has(primary)) return primary;
  return DEFAULT_LANGUAGE;
}

/** Resolve the OS / browser locale to a supported language code. In
 *  Electron, `navigator.language` mirrors `app.getLocale()` which mirrors
 *  the OS, so this single call covers every platform without needing IPC. */
export function detectSystemLanguage(): string {
  try {
    const navTag =
      typeof navigator !== 'undefined' ? navigator.language : undefined;
    return resolveLanguage(navTag);
  } catch {
    return DEFAULT_LANGUAGE;
  }
}

export function isSupportedLanguage(code: string | null | undefined): boolean {
  if (!code) return false;
  return SUPPORTED_CODES.has(code);
}
