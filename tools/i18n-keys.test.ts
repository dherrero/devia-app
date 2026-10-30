import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extractMissing,
  flatten,
  mergeTranslations,
  placeholdersOf,
  serialize,
  type FlatMap,
  type JsonDoc,
} from './i18n-keys';

const REF = {
  chat: { send: 'Send', queued: 'Queued at #{{pos}}' },
  panes: { close: 'Close' },
};

describe('flatten', () => {
  it('walks to string leaves in document order', () => {
    expect(flatten(REF)).toEqual({
      'chat.send': 'Send',
      'chat.queued': 'Queued at #{{pos}}',
      'panes.close': 'Close',
    });
  });

  it('ignores non-string leaves instead of stringifying them', () => {
    expect(flatten({ a: 1, b: true, c: null, d: ['x'], e: 'ok' })).toEqual({ e: 'ok' });
  });
});

describe('placeholdersOf', () => {
  it('collects names, deduplicated and sorted', () => {
    expect(placeholdersOf('{{b}} and {{a}} and {{b}} again')).toEqual(['a', 'b']);
  });

  it('tolerates inner spacing', () => {
    expect(placeholdersOf('{{ count }}')).toEqual(['count']);
  });

  it('returns nothing for plain text', () => {
    expect(placeholdersOf('no placeholders here')).toEqual([]);
  });
});

describe('extractMissing', () => {
  it('returns only what the language lacks, in reference order', () => {
    const lang = { chat: { send: 'Enviar' } };

    expect(Object.keys(extractMissing(REF, lang))).toEqual(['chat.queued', 'panes.close']);
  });

  it('is empty for a complete language', () => {
    expect(extractMissing(REF, REF)).toEqual({});
  });

  it('is stable: extracting twice gives an identical document', () => {
    const lang = { chat: { send: 'Enviar' } };

    expect(serialize(extractMissing(REF, lang))).toBe(serialize(extractMissing(REF, lang)));
  });
});

describe('mergeTranslations', () => {
  const lang = (): JsonDoc => ({ chat: { send: 'Enviar' } });

  it('writes the translations into the nested document', () => {
    const result = mergeTranslations(REF, lang(), {
      'chat.queued': 'En cola en el #{{pos}}',
      'panes.close': 'Cerrar',
    });

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['chat.queued', 'panes.close']);
    expect(result.doc).toEqual({
      chat: { send: 'Enviar', queued: 'En cola en el #{{pos}}' },
      panes: { close: 'Cerrar' },
    });
  });

  it('never mutates the document it was given', () => {
    const original = lang();
    mergeTranslations(REF, original, { 'panes.close': 'Cerrar' });

    expect(original).toEqual({ chat: { send: 'Enviar' } });
  });

  it('leaves already-translated keys untouched', () => {
    const result = mergeTranslations(REF, lang(), { 'panes.close': 'Cerrar' });

    expect((result.doc?.['chat'] as JsonDoc)['send']).toBe('Enviar');
  });

  describe('refuses the WHOLE merge — a partial write is harder to undo', () => {
    it('when a key is not part of the extract', () => {
      const result = mergeTranslations(REF, lang(), {
        'panes.close': 'Cerrar',
        'chat.send': 'Ya traducida',
      });

      expect(result.doc).toBeUndefined();
      expect(result.applied).toEqual([]);
      expect(result.errors.join(' ')).toContain('chat.send');
      expect(result.errors.join(' ')).toContain('wrong file');
    });

    it('when a key does not exist in the reference at all', () => {
      const result = mergeTranslations(REF, lang(), { 'ghost.key': 'x' });

      expect(result.doc).toBeUndefined();
      expect(result.errors.join(' ')).toContain('ghost.key');
    });

    it('when a placeholder was lost in translation', () => {
      const result = mergeTranslations(REF, lang(), { 'chat.queued': 'En cola' });

      // A lost interpolation is broken text on screen, not a typo.
      expect(result.doc).toBeUndefined();
      expect(result.errors[0]).toContain('chat.queued');
      expect(result.errors[0]).toContain('placeholders differ');
    });

    it('when a placeholder was renamed', () => {
      const result = mergeTranslations(REF, lang(), { 'chat.queued': 'En cola en el #{{posicion}}' });

      expect(result.doc).toBeUndefined();
      expect(result.errors[0]).toContain('placeholders differ');
    });

    it('when a value is not a string', () => {
      const result = mergeTranslations(REF, lang(), { 'panes.close': 3 as unknown as string });

      expect(result.doc).toBeUndefined();
      expect(result.errors[0]).toContain('expected a string');
    });
  });

  it('accepts a placeholder moved to a different position', () => {
    const result = mergeTranslations(REF, lang(), { 'chat.queued': '#{{pos}} en la cola' });

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['chat.queued']);
  });

  it('skips blanks instead of failing — a partial delivery still lands', () => {
    const result = mergeTranslations(REF, lang(), {
      'chat.queued': '   ',
      'panes.close': 'Cerrar',
    });

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual(['panes.close']);
    expect(result.skipped).toEqual(['chat.queued']);
    // An empty string would render as blank UI, so it must not be written.
    expect((result.doc?.['chat'] as JsonDoc)['queued']).toBeUndefined();
  });
});

describe('round trip against the real files', () => {
  const DIR = path.resolve(__dirname, '..', 'src', 'renderer', 'assets', 'i18n');
  const read = (lang: string): JsonDoc =>
    JSON.parse(readFileSync(path.join(DIR, `${lang}.json`), 'utf8')) as JsonDoc;

  it('extracts the real gap for a shipped language', () => {
    const missing = extractMissing(read('en'), read('de'));

    // Measured 2026-08-01. If this drifts, a batch landed (raise it) or a key
    // was added untranslated (the parity gate should have caught it).
    // 269: +4 for the auto-continue switch and banner (es/en only).
    expect(Object.keys(missing).length).toBe(269);
  });

  it('extracts nothing for the complete language', () => {
    expect(extractMissing(read('en'), read('es'))).toEqual({});
  });

  it('merging an UNTRANSLATED extract changes nothing at all', () => {
    // Everything blank → every key skipped → the document must come back
    // byte-identical, including key order.
    const before = read('de');
    const blanks: FlatMap = {};
    for (const key of Object.keys(extractMissing(read('en'), before))) blanks[key] = '';

    const result = mergeTranslations(read('en'), before, blanks);

    expect(result.errors).toEqual([]);
    expect(result.applied).toEqual([]);
    expect(serialize(result.doc)).toBe(serialize(before));
  });

  it('serialises in the shape the files already use', () => {
    const raw = readFileSync(path.join(DIR, 'es.json'), 'utf8');

    expect(serialize(read('es'))).toBe(raw);
  });
});
