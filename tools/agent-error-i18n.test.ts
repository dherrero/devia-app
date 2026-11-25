import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { AGENT_ERROR_CODES } from '../src/shared/domain/user-facing-error';
import { flatten, type JsonDoc } from './i18n-keys';

const I18N = path.join(__dirname, '..', 'src', 'renderer', 'assets', 'i18n');
const EXPLAIN = path.join(__dirname, '..', 'src', 'main', 'features', 'cli-adapters', 'infrastructure', 'explain');
const load = (lang: string): Record<string, string> =>
  flatten(JSON.parse(readFileSync(path.join(I18N, `${lang}.json`), 'utf8')) as JsonDoc);

describe('agent error translations (S-54)', () => {
  for (const lang of ['en', 'es']) {
    it(`${lang}: every code has a title and a cause`, () => {
      const flat = load(lang);
      for (const code of AGENT_ERROR_CODES) {
        expect(flat[`agent_error.${code}.title`], `${lang} agent_error.${code}.title`).toBeTruthy();
        const causes = Object.keys(flat).filter((k) => k === `agent_error.${code}.cause` || k.startsWith(`agent_error.${code}.cause_`));
        expect(causes.length, `${lang} agent_error.${code}.cause*`).toBeGreaterThan(0);
      }
    });
  }

  it('every code written in an explainer is declared in AGENT_ERROR_CODES', () => {
    const declared = new Set<string>(AGENT_ERROR_CODES);
    const used = new Set<string>();
    for (const file of readdirSync(EXPLAIN).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))) {
      const src = readFileSync(path.join(EXPLAIN, file), 'utf8');
      for (const m of src.matchAll(/\bcode:\s*'([a-z_]+)'|make\(\s*'([a-z_]+)'/g)) used.add((m[1] ?? m[2]) as string);
    }
    expect([...used].filter((c) => !declared.has(c))).toEqual([]);
  });
});
