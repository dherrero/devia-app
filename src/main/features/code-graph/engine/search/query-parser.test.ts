import { describe, expect, it } from 'vitest';
import { parseQuery } from './query-parser';

describe('parseQuery', () => {
  it('splits camelCase, PascalCase acronyms, snake, kebab and dotted tokens', () => {
    expect(parseQuery('getUserById')).toEqual({
      terms: ['get', 'user', 'by', 'id'],
      literal: ['getuserbyid'],
    });
    expect(parseQuery('HTTPServer').terms).toEqual(['http', 'server']);
    expect(parseQuery('a.b_c').terms).toEqual(['a', 'b', 'c']);
    expect(parseQuery('get-user').terms).toEqual(['get', 'user']);
  });

  it('drops FTS5 operators and specials', () => {
    expect(parseQuery('AND OR NOT NEAR')).toEqual({ terms: [], literal: [] });
    expect(parseQuery('(((')).toEqual({ terms: [], literal: [] });
    expect(parseQuery('foo"bar -x').terms).toEqual(['foo', 'bar', 'x']);
    expect(parseQuery('foo"bar -x').phrase).toBeUndefined();
  });

  it('reports a phrase only for a balanced double-quoted phrase', () => {
    expect(parseQuery('"get user" x').phrase).toBe('get user');
    expect(parseQuery('""').phrase).toBeUndefined();
  });

  it('returns empty for empty or whitespace input', () => {
    expect(parseQuery('')).toEqual({ terms: [], literal: [] });
    expect(parseQuery('   ')).toEqual({ terms: [], literal: [] });
  });

  it('keeps unicode identifiers', () => {
    expect(parseQuery('ñandú').terms).toEqual(['ñandú']);
    expect(parseQuery('日本語').terms).toEqual(['日本語']);
  });
});
