export interface ParsedQuery {
  terms: string[];
  literal: string[];
  phrase?: string;
}

const FTS_OPERATORS = new Set(['NEAR', 'AND', 'OR', 'NOT']);
const WORD = /[\p{L}\p{N}]+/gu;

export function splitIdentifier(token: string): string[] {
  const spaced = token
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2')
    .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2');
  return (spaced.match(WORD) ?? []).map((w) => w.toLowerCase());
}

export function words(text: string): string[] {
  return text.toLowerCase().match(WORD) ?? [];
}

export const MAX_QUERY_CHARS = 200;
export const MAX_QUERY_TERMS = 12;

// Input beyond MAX_QUERY_CHARS characters, or beyond MAX_QUERY_TERMS terms or
// tokens, is ignored so a hostile query cannot blow up SQL expression limits.
export function parseQuery(input: string): ParsedQuery {
  const q = input.slice(0, MAX_QUERY_CHARS);
  const result: ParsedQuery = { terms: [], literal: [] };
  const quoted = /"([^"]*)"/.exec(q);
  if (quoted) {
    const phrase = words(quoted[1] ?? '').join(' ');
    if (phrase) result.phrase = phrase;
  }
  const tokens = q
    .replace(/["'\-(){}*:^]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0 && !FTS_OPERATORS.has(t));
  const seen = new Set<string>();
  for (const token of tokens) {
    if (result.literal.length >= MAX_QUERY_TERMS) break;
    const literal = token.toLowerCase().replace(/[^\p{L}\p{N}_%.]/gu, '');
    if (!/[\p{L}\p{N}%]/u.test(literal)) continue;
    result.literal.push(literal);
    for (const seg of splitIdentifier(token)) {
      if (!seen.has(seg) && result.terms.length < MAX_QUERY_TERMS) {
        seen.add(seg);
        result.terms.push(seg);
      }
    }
  }
  return result;
}
