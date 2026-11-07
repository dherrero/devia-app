import type {
  CodeGraphLanguage,
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import type {
  GraphQueries,
  SearchFilter,
  SearchRow,
} from '../db/queries';
import { parseQuery, splitIdentifier, words, type ParsedQuery } from './query-parser';

export interface SearchOptions {
  kinds?: NodeKind[];
  language?: CodeGraphLanguage;
  limit?: number;
  includeTests?: boolean;
  includeGenerated?: boolean;
  useFts?: boolean;
}

export interface SearchResult {
  node: GraphNode;
  score: number;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;

export const SEARCH_WEIGHTS = {
  exactName: 100,
  prefixName: 60,
  segmentName: 40,
  substringName: 30,
  qualifiedName: 15,
  docOrSignature: 8,
  exported: 5,
  testPenalty: -20,
  generatedPenalty: -20,
  bm25Max: 4,
  candidateMultiplier: 5,
  candidateMin: 100,
  candidateMax: 1000,
} as const;

const alnum = (s: string): string => s.replace(/[^\p{L}\p{N}]/gu, '');

function ftsExpression(parsed: ParsedQuery): string | undefined {
  const clauses: string[] = [];
  for (const lit of parsed.literal) {
    for (const w of words(lit)) clauses.push(`"${w}"*`);
  }
  if (parsed.phrase) clauses.push(`"${parsed.phrase}"`);
  if (clauses.length === 0) return undefined;
  return `{name qualified_name} : (${clauses.join(' AND ')})`;
}

function substringPatternSets(parsed: ParsedQuery): string[][] {
  if (parsed.literal.some((l) => l.includes('%'))) return [parsed.literal];
  const sets = [parsed.terms];
  const lit = parsed.literal;
  if (lit.length > 0 && lit.join('\0') !== parsed.terms.join('\0')) sets.push(lit);
  return sets;
}

function scoreRow(row: SearchRow, parsed: ParsedQuery): number {
  const w = SEARCH_WEIGHTS;
  const { node } = row;
  const qNorm = parsed.literal.map(alnum).join('');
  const nameNorm = alnum(node.name.toLowerCase());
  const segs = splitIdentifier(node.name);
  let score = 0;
  if (nameNorm === qNorm) score = w.exactName;
  else if (nameNorm.startsWith(qNorm)) score = w.prefixName;
  else if (
    parsed.terms.length > 0 &&
    parsed.terms.every((t) => segs.some((s) => s.startsWith(t)))
  )
    score = w.segmentName;
  else if (nameNorm.includes(qNorm)) score = w.substringName;
  else {
    const qn = node.qualifiedName.toLowerCase();
    if (parsed.terms.length > 0 && parsed.terms.every((t) => qn.includes(t)))
      score = w.qualifiedName;
  }
  const text = `${node.docstring ?? ''} ${node.signature ?? ''}`.toLowerCase();
  if (parsed.terms.some((t) => text.includes(t))) score += w.docOrSignature;
  if (node.isExported) score += w.exported;
  if (row.fileIsTest || node.isTest) score += w.testPenalty;
  if (row.fileGenerated) score += w.generatedPenalty;
  if (row.bm25 !== undefined)
    score += Math.min(w.bm25Max, Math.max(0, -row.bm25) / 10);
  return score;
}

function ftsCandidates(
  db: GraphQueries,
  parsed: ParsedQuery,
  cap: number,
  filter: SearchFilter,
): SearchRow[] | undefined {
  const expr = ftsExpression(parsed);
  if (!expr) return [];
  try {
    return db.searchFts(expr, cap, filter);
  } catch {
    return undefined;
  }
}

export function searchSymbols(
  db: GraphQueries,
  query: string,
  opts: SearchOptions = {},
): SearchResult[] {
  const parsed = parseQuery(query);
  if (parsed.literal.length === 0) return [];
  const limit = Math.min(
    MAX_LIMIT,
    Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIMIT) || DEFAULT_LIMIT),
  );
  const w = SEARCH_WEIGHTS;
  const cap = Math.min(
    w.candidateMax,
    Math.max(w.candidateMin, limit * w.candidateMultiplier),
  );
  const filter: SearchFilter = {
    includeTests: opts.includeTests ?? true,
    includeGenerated: opts.includeGenerated ?? false,
  };
  if (opts.kinds) filter.kinds = opts.kinds;
  if (opts.language) filter.language = opts.language;

  const byId = new Map<string, SearchRow>();
  const add = (rows: SearchRow[]): void => {
    for (const r of rows) if (!byId.has(r.node.id)) byId.set(r.node.id, r);
  };
  const fts =
    opts.useFts === false ? undefined : ftsCandidates(db, parsed, cap, filter);
  if (fts) add(fts);
  // FTS tokenises whole identifiers, so camelCase segments need the substring scan.
  if (!fts || fts.length < limit) {
    for (const patterns of substringPatternSets(parsed)) {
      add(db.searchSubstring(patterns, cap, filter));
    }
  }

  const scored = [...byId.values()].map((row) => ({
    node: row.node,
    score: scoreRow(row, parsed),
  }));
  const symbols = scored.filter((r) => r.node.kind !== 'file');
  const pool = symbols.length > 0 ? symbols : scored;
  pool.sort(
    (a, b) =>
      b.score - a.score ||
      (a.node.qualifiedName < b.node.qualifiedName
        ? -1
        : a.node.qualifiedName > b.node.qualifiedName
          ? 1
          : 0) ||
      (a.node.id < b.node.id ? -1 : a.node.id > b.node.id ? 1 : 0),
  );
  return pool.slice(0, limit);
}
