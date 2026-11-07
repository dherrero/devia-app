import type { GraphNode } from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';
import { getExploreOutputBudget } from './explore-budget';
import { readSourceRange } from './source-reader';
import { lookupSymbol } from './symbol-lookup';
import { findPath, getCallees, getCallers } from './traversal';

export interface ExploreSnippet {
  startLine: number;
  endLine: number;
  text: string;
}

export interface ExploreFile {
  path: string;
  snippets: ExploreSnippet[];
}

export interface ExploreResult {
  flow: GraphNode[][];
  files: ExploreFile[];
  unresolvedNames: string[];
  markdown: string;
  found: number;
}

export interface ExploreOptions {
  budgetFiles?: number;
}

const MAX_TOKENS = 12;
const PAIR_MATCH_CAP = 5;
const MAX_BRIDGE_FANOUT = 25;
const NEIGHBOUR_NODES_PER_SYMBOL = 3;
const MAX_NAMED_NODES = 40;
const SNIPPET_LINE_CAP = 400;

function fanOut(db: GraphQueries, id: string): number {
  return db.edgesFrom(id, ['calls', 'instantiates']).length;
}

function validBridge(
  db: GraphQueries,
  path: GraphNode[],
  named: Set<string>,
): boolean {
  const unnamed = path.slice(1, -1).filter((n) => !named.has(n.id));
  if (unnamed.length > 1) return false;
  return unnamed.every((n) => fanOut(db, n.id) <= MAX_BRIDGE_FANOUT);
}

function pathBetween(
  db: GraphQueries,
  from: GraphNode[],
  to: GraphNode[],
  named: Set<string>,
): GraphNode[] | undefined {
  for (const [a, b] of [
    [from, to],
    [to, from],
  ] as const) {
    for (const x of a.slice(0, PAIR_MATCH_CAP)) {
      for (const y of b.slice(0, PAIR_MATCH_CAP)) {
        if (x.id === y.id) continue;
        const p = findPath(db, x.id, y.id, { maxDepth: 2 });
        if (p && validBridge(db, p, named)) return p;
      }
    }
  }
  return undefined;
}

function mergeFlows(paths: GraphNode[][]): GraphNode[][] {
  const merged: GraphNode[][] = [];
  for (const p of paths) {
    const last = merged[merged.length - 1];
    if (last && last[last.length - 1]?.id === p[0]?.id)
      last.push(...p.slice(1));
    else merged.push([...p]);
  }
  return merged;
}

function trimToLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const lines = text.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = line.length + (kept.length > 0 ? 1 : 0);
    if (used + cost > maxChars) break;
    kept.push(line);
    used += cost;
  }
  return kept.join('\n');
}

function label(n: GraphNode): string {
  return `${n.qualifiedName} (${n.filePath}:${n.startLine})`;
}

const SUGGEST =
  'Call `graph_explore` again with other symbol names (also `Class.method` or `file.ts#name`), or `graph_node` with an exact name for one symbol\'s full body and callers.';

function unresolvedText(names: string[]): string {
  return `Not found in the graph: ${names.map((n) => `\`${n}\``).join(', ')}. ${SUGGEST}`;
}

export function exploreSymbols(
  db: GraphQueries,
  root: string,
  query: string,
  opts: ExploreOptions = {},
): ExploreResult {
  const tokens = [
    ...new Set(query.split(/\s+/).filter((t) => t.length > 0)),
  ].slice(0, MAX_TOKENS);
  const resolved = tokens.map((t) => ({ token: t, nodes: lookupSymbol(db, t) }));
  const unresolvedNames = resolved
    .filter((r) => r.nodes.length === 0)
    .map((r) => r.token);
  const hits = resolved.filter((r) => r.nodes.length > 0);

  if (hits.length === 0) {
    const markdown =
      tokens.length === 0
        ? `No symbol names given. ${SUGGEST}`
        : unresolvedText(unresolvedNames);
    return { flow: [], files: [], unresolvedNames, markdown, found: 0 };
  }

  const named = new Set(hits.flatMap((r) => r.nodes.map((n) => n.id)));
  const paths: GraphNode[][] = [];
  for (let i = 0; i + 1 < hits.length; i++) {
    const a = hits[i];
    const b = hits[i + 1];
    if (!a || !b) continue;
    const p = pathBetween(db, a.nodes, b.nodes, named);
    if (p) paths.push(p);
  }
  const flow = mergeFlows(paths);

  const namedNodes = hits.flatMap((r) => r.nodes).slice(0, MAX_NAMED_NODES);
  const flowNodes = flow.flat();
  const neighbourNodes: GraphNode[] = [];
  for (const n of namedNodes.slice(0, 10)) {
    const around = [
      ...getCallers(db, n.id, { depth: 1, limit: NEIGHBOUR_NODES_PER_SYMBOL }),
      ...getCallees(db, n.id, { depth: 1, limit: NEIGHBOUR_NODES_PER_SYMBOL }),
    ];
    for (const h of around) neighbourNodes.push(h.node);
  }

  const byFile = new Map<string, Map<string, GraphNode>>();
  for (const n of [...namedNodes, ...flowNodes, ...neighbourNodes]) {
    let nodes = byFile.get(n.filePath);
    if (!nodes) byFile.set(n.filePath, (nodes = new Map()));
    nodes.set(n.id, n);
  }

  const budget = getExploreOutputBudget(db.counts().files);
  const maxFiles = opts.budgetFiles ?? budget.maxFiles;
  const orderedPaths = [...byFile.keys()].slice(0, Math.max(1, maxFiles));

  const headParts: string[] = [];
  if (flow.length > 0) {
    headParts.push(
      '## Flow',
      ...flow.map((chain) => chain.map(label).join(' → ')),
      '',
    );
  }
  if (unresolvedNames.length > 0) headParts.push(unresolvedText(unresolvedNames), '');
  headParts.push('## Sources');
  const reserve = 400;
  let remaining = budget.maxChars - headParts.join('\n').length - reserve;

  const files: ExploreFile[] = [];
  const sourceParts: string[] = [];
  const omitted: string[] = [];
  for (const filePath of orderedPaths) {
    const nodes = [...(byFile.get(filePath)?.values() ?? [])].sort(
      (a, b) => a.startLine - b.startLine || b.endLine - a.endLine,
    );
    let fileBudget = Math.min(budget.maxCharsPerFile, remaining - 60);
    if (fileBudget <= 0) {
      omitted.push(filePath);
      continue;
    }
    const snippets: ExploreSnippet[] = [];
    let covered = 0;
    for (const n of nodes) {
      if (n.endLine <= covered && n.startLine <= covered) continue;
      const end = Math.min(n.endLine, n.startLine + SNIPPET_LINE_CAP - 1);
      const raw = readSourceRange(root, filePath, n.startLine, end);
      const text = trimToLines(raw, fileBudget);
      if (text === '') continue;
      const shown = text.split('\n').length;
      const snippetEnd = text === raw ? n.endLine : n.startLine + shown - 1;
      snippets.push({ startLine: n.startLine, endLine: snippetEnd, text });
      fileBudget -= text.length + 1;
      covered = Math.max(covered, snippetEnd);
      if (text !== raw || fileBudget <= 0) break;
    }
    if (snippets.length === 0) continue;
    files.push({ path: filePath, snippets });
    const block = [
      `### ${filePath}`,
      ...snippets.flatMap((s) => [
        `lines ${s.startLine}-${s.endLine}`,
        '```',
        s.text,
        '```',
      ]),
    ].join('\n');
    sourceParts.push(block);
    remaining -= block.length + 1;
  }

  const tail: string[] = [];
  const dropped = byFile.size - orderedPaths.length;
  if (omitted.length > 0 || dropped > 0) {
    const names = [...omitted, ...[...byFile.keys()].slice(orderedPaths.length)];
    tail.push(
      `More relevant files not shown: ${names.slice(0, 8).join(', ')}. Call \`graph_node\` on a symbol from them for its full body.`,
    );
  }

  const markdown = [...headParts, ...sourceParts, ...tail].join('\n');
  return { flow, files, unresolvedNames, markdown, found: hits.length };
}
