import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Orphan gate for the `codeGraph` namespace (S-44 T-514).
 *
 * Every key must be used by the renderer, either literally (`'codeGraph.x'`)
 * or through one of the prefixes the code builds at runtime from a domain
 * value (node kind, edge kind, index phase, stale reason). An unused key is a
 * string eleven translators keep maintaining for nothing; T-513 left 7 of them.
 */
const ROOT = path.resolve(__dirname, '..');
const EN = path.join(ROOT, 'src', 'renderer', 'assets', 'i18n', 'en.json');
const APP = path.join(ROOT, 'src', 'renderer', 'app');

/** Prefixes completed at runtime with a domain value (see the components). */
const DYNAMIC_PREFIXES = [
  'codeGraph.canvas.kind.',
  'codeGraph.filters.edge.',
  'codeGraph.progress.phase.',
  'codeGraph.toolbar.stale_reason.',
];

function leaves(doc: unknown, prefix: string): string[] {
  if (typeof doc === 'string') return [prefix];
  if (doc === null || typeof doc !== 'object') return [];
  return Object.entries(doc as Record<string, unknown>).flatMap(([k, v]) => leaves(v, `${prefix}.${k}`));
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sources(p);
    return /\.(ts|html)$/.test(e.name) && !e.name.endsWith('.spec.ts') ? [readFileSync(p, 'utf8')] : [];
  });
}

describe('codeGraph i18n keys', () => {
  const en = JSON.parse(readFileSync(EN, 'utf8')) as { codeGraph: unknown };
  const keys = leaves(en.codeGraph, 'codeGraph');
  const code = sources(APP).join('\n');

  it('has keys to check (the namespace exists)', () => {
    expect(keys.length).toBeGreaterThan(100);
  });

  it('every key is referenced by the renderer, literally or through a dynamic prefix', () => {
    const orphans = keys.filter((key) => {
      if (DYNAMIC_PREFIXES.some((p) => key.startsWith(p))) return false;
      const base = key.replace(/_plural$/, '');
      return ![`'${base}'`, `"${base}"`, `\`${base}`].some((needle) => code.includes(needle));
    });
    expect(orphans).toEqual([]);
  });

  it('every dynamic prefix is really built by the renderer', () => {
    for (const prefix of DYNAMIC_PREFIXES) {
      expect(code.includes(`'${prefix}' +`) || code.includes(`\`${prefix}\${`)).toBe(true);
    }
  });
});
