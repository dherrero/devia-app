import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * i18n parity gate (S-27 I0.1).
 *
 * A missing key does NOT fall back to English in this app — `@ngx-translate`
 * renders the raw key path, so the user sees `sdd.event.task_done` inside a
 * button. This test is what catches that before a release.
 *
 * TWO RATCHETS, both of which only ever grow:
 *
 *   1. COMPLETE_LANGUAGES — the whole document must match `en`. A language
 *      joins this list in the same PR that finishes translating it.
 *
 *   2. PROTECTED_NAMESPACES — these areas must match in EVERY language,
 *      including the unfinished ones. Seeded with the 16 namespaces that were
 *      already complete everywhere (181 of 819 keys), so a new key in, say,
 *      `diff_viewer` cannot be merged untranslated.
 *
 * Never remove an entry from either list to make a build green. Adding a key
 * to `en` and not to a protected language is the failure this exists to catch;
 * the fix is the translation, not the list.
 *
 * Measured 2026-08-01: `en` has 819 keys. `es` is complete; the other nine sit
 * at ~67.5%, each missing 265-267. S-27 closes that in batches.
 */
const DIR = path.resolve(__dirname, '..', 'renderer', 'assets', 'i18n');
const REFERENCE = 'en';

/** Whole-document parity. Grows one language per S-27 batch. */
const COMPLETE_LANGUAGES: readonly string[] = ['es'];

/** Enforced in EVERY language, finished or not. */
const PROTECTED_NAMESPACES: readonly string[] = [
  'app',
  'bubble_progress',
  'diff_viewer',
  'empty_state',
  'error_card',
  'message_bubble',
  'question_card',
  'queue',
  'quick_replies',
  'splash',
  'terminal',
  'titlebar',
  'tool_card',
  'tool_group',
  'tool_summary',
  'ui_tools',
];

/**
 * Languages shipped but not yet complete. Listed explicitly so a NEW language
 * file cannot appear without someone classifying it — an unclassified file
 * would otherwise be silently exempt from the whole-document check.
 */
const KNOWN_INCOMPLETE: readonly string[] = ['ar', 'ca', 'de', 'fr', 'hi', 'it', 'pt', 'ru', 'zh'];

function leafKeys(value: unknown, prefix = ''): string[] {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leafKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function keysOf(lang: string): string[] {
  const doc = JSON.parse(readFileSync(path.join(DIR, `${lang}.json`), 'utf8')) as unknown;
  return leafKeys(doc);
}

/** A readable failure: the actual keys, not a count. Capped so a big gap stays legible. */
function report(missing: readonly string[]): string[] {
  if (missing.length <= 15) return [...missing];
  return [...missing.slice(0, 15), `…and ${missing.length - 15} more`];
}

const languages = readdirSync(DIR)
  .filter((f) => f.endsWith('.json'))
  .map((f) => f.replace('.json', ''));

const referenceKeys = keysOf(REFERENCE);
const others = languages.filter((l) => l !== REFERENCE);

describe('i18n parity — bookkeeping', () => {
  it('is not vacuous: a real reference and several languages', () => {
    expect(languages).toContain(REFERENCE);
    expect(others.length).toBeGreaterThan(5);
    expect(referenceKeys.length).toBeGreaterThan(500);
  });

  it('every shipped language is classified as complete or known-incomplete', () => {
    // Stops a new file from being silently exempt from the whole-document gate.
    const unclassified = others.filter(
      (l) => !COMPLETE_LANGUAGES.includes(l) && !KNOWN_INCOMPLETE.includes(l),
    );

    expect(unclassified).toEqual([]);
  });

  it('no language is listed as both complete and incomplete', () => {
    expect(COMPLETE_LANGUAGES.filter((l) => KNOWN_INCOMPLETE.includes(l))).toEqual([]);
  });

  it('every protected namespace exists in the reference', () => {
    const roots = new Set(referenceKeys.map((k) => k.split('.')[0]));
    expect(PROTECTED_NAMESPACES.filter((ns) => !roots.has(ns))).toEqual([]);
  });
});

describe('i18n parity — complete languages (whole document)', () => {
  it.each(COMPLETE_LANGUAGES)('%s translates every key of the reference', (lang) => {
    const present = new Set(keysOf(lang));
    const missing = referenceKeys.filter((key) => !present.has(key));

    expect(report(missing)).toEqual([]);
  });

  it.each(COMPLETE_LANGUAGES)('%s has no key the reference lacks', (lang) => {
    const expected = new Set(referenceKeys);
    const extra = keysOf(lang).filter((key) => !expected.has(key));

    expect(report(extra)).toEqual([]);
  });
});

describe('i18n parity — protected namespaces (every language)', () => {
  const protectedKeys = referenceKeys.filter((k) =>
    PROTECTED_NAMESPACES.includes(k.split('.')[0] ?? ''),
  );

  it('the protected set is a meaningful slice, not a token one', () => {
    expect(protectedKeys.length).toBeGreaterThan(150);
  });

  it.each(others)('%s translates every protected key', (lang) => {
    const present = new Set(keysOf(lang));
    const missing = protectedKeys.filter((key) => !present.has(key));

    expect(report(missing)).toEqual([]);
  });
});
