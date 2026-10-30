import { readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

/**
 * Extract / merge helper for the i18n batches (S-27 I0.2).
 *
 * Without this, each batch means eyeballing two nested JSON documents to work
 * out what is missing — which is exactly how nine languages drifted 265 keys
 * behind without anyone noticing.
 *
 * FORMAT: the interchange file is a FLAT JSON object (`{"a.b.c": "text"}`),
 * not `key = text`. Measured on `en.json`: no value contains a newline, but
 * three contain `=` and 109 carry `{{placeholders}}`. A delimiter format would
 * need escaping rules for those; flat JSON needs none, and every translation
 * tool reads it.
 */

export type JsonDoc = Record<string, unknown>;
export type FlatMap = Record<string, string>;

/** Placeholder syntax used by ngx-translate: `{{name}}`. */
const PLACEHOLDER = /\{\{\s*([\w.]+)\s*\}\}/g;

/** Leaf paths in document order. Only string leaves are translatable. */
export function flatten(doc: unknown, prefix = ''): FlatMap {
  if (typeof doc === 'string') return prefix ? { [prefix]: doc } : {};
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return {};
  const out: FlatMap = {};
  for (const [key, child] of Object.entries(doc as JsonDoc)) {
    Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/** The placeholder NAMES a string uses, sorted and deduplicated. */
export function placeholdersOf(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PLACEHOLDER)) {
    if (match[1]) found.add(match[1]);
  }
  return [...found].sort();
}

/**
 * What `lang` is missing relative to `reference`, in REFERENCE DOCUMENT ORDER.
 *
 * Stable order matters: a translator working through the file twice should see
 * the same sequence, and the diff of a regenerated extract should be empty.
 */
export function extractMissing(reference: unknown, lang: unknown): FlatMap {
  const ref = flatten(reference);
  const present = flatten(lang);
  const out: FlatMap = {};
  for (const [key, value] of Object.entries(ref)) {
    if (!(key in present)) out[key] = value;
  }
  return out;
}

export interface MergeResult {
  /** The updated document. Absent when `errors` is non-empty. */
  doc?: JsonDoc;
  /** Keys actually written. */
  applied: string[];
  /** Keys left blank by the translator — reported, not fatal. */
  skipped: string[];
  /** Fatal problems. When non-empty NOTHING is written. */
  errors: string[];
}

/**
 * Reinject translations into `langDoc`.
 *
 * Refuses the WHOLE merge (writes nothing) when it finds a key that was not in
 * the extract, or a translation whose placeholders do not match the reference.
 * Both mean the file came from somewhere else, and a partial write would be
 * harder to undo than a refusal.
 *
 * A blank translation is skipped, not fatal: a translator delivering 200 of
 * 265 should not be blocked, and an empty string would render as blank UI.
 */
export function mergeTranslations(
  reference: unknown,
  langDoc: JsonDoc,
  translations: FlatMap,
): MergeResult {
  const ref = flatten(reference);
  const allowed = extractMissing(reference, langDoc);
  const applied: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const [key, value] of Object.entries(translations)) {
    if (!(key in allowed)) {
      errors.push(
        key in ref
          ? `${key}: already translated in this language — wrong file?`
          : `${key}: not a key of the reference — wrong file?`,
      );
      continue;
    }
    if (typeof value !== 'string') {
      errors.push(`${key}: expected a string`);
      continue;
    }
    if (!value.trim()) {
      skipped.push(key);
      continue;
    }
    const expected = placeholdersOf(ref[key] ?? '');
    const got = placeholdersOf(value);
    if (expected.join('|') !== got.join('|')) {
      // A lost interpolation is broken text on screen, not a typo.
      errors.push(
        `${key}: placeholders differ — expected {{${expected.join('}}, {{')}}}, got ` +
          (got.length ? `{{${got.join('}}, {{')}}}` : 'none'),
      );
      continue;
    }
    applied.push(key);
  }

  if (errors.length > 0) return { applied: [], skipped: [], errors };

  // Deep-clone so a caller that inspects `langDoc` afterwards sees it unchanged.
  const doc = JSON.parse(JSON.stringify(langDoc)) as JsonDoc;
  for (const key of applied) setDeep(doc, key.split('.'), translations[key] as string);
  return { doc, applied, skipped, errors };
}

/**
 * Write a leaf, creating intermediate objects. Existing keys keep their
 * position — JS objects preserve insertion order, so a new key lands at the
 * end of its parent and the rest of the diff stays clean.
 */
function setDeep(target: JsonDoc, segments: string[], value: string): void {
  let node = target;
  for (let i = 0; i < segments.length - 1; i++) {
    const segment = segments[i] as string;
    const next = node[segment];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) node[segment] = {};
    node = node[segment] as JsonDoc;
  }
  node[segments[segments.length - 1] as string] = value;
}

/** Same shape the i18n files already use: 2-space indent, trailing newline. */
export function serialize(doc: unknown): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

const I18N_DIR = path.resolve(__dirname, '..', 'renderer', 'assets', 'i18n');
const REFERENCE = 'en';

function readDoc(lang: string): JsonDoc {
  return JSON.parse(readFileSync(path.join(I18N_DIR, `${lang}.json`), 'utf8')) as JsonDoc;
}

export function runCli(argv: string[]): number {
  const [command, lang, file] = argv;

  if (command === 'extract' && lang) {
    const missing = extractMissing(readDoc(REFERENCE), readDoc(lang));
    // NOT inside I18N_DIR: the parity gate treats every `*.json` in there as a
    // shipped language, so dropping `de.missing.json` next to `de.json` would
    // fail the build just for running this tool.
    const out = file ?? path.resolve(process.cwd(), `${lang}.missing.json`);
    writeFileSync(out, serialize(missing), 'utf8');
    console.log(`${Object.keys(missing).length} keys → ${out}`);
    return 0;
  }

  if (command === 'merge' && lang && file) {
    const translations = JSON.parse(readFileSync(file, 'utf8')) as FlatMap;
    const result = mergeTranslations(readDoc(REFERENCE), readDoc(lang), translations);
    if (result.errors.length > 0) {
      console.error(`Refused — nothing written (${result.errors.length} problems):`);
      for (const error of result.errors) console.error(`  ${error}`);
      return 1;
    }
    writeFileSync(path.join(I18N_DIR, `${lang}.json`), serialize(result.doc), 'utf8');
    console.log(`${result.applied.length} applied, ${result.skipped.length} left blank`);
    return 0;
  }

  console.error('usage: i18n-keys extract <lang> [out] | merge <lang> <file>');
  return 2;
}

if (require.main === module) process.exit(runCli(process.argv.slice(2)));
