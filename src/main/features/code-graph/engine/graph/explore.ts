import type { GraphNode } from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';
import { getExploreOutputBudget } from './explore-budget';
import { fenced } from './fence';
import { createSourceReader, type SourceReader } from './source-reader';
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
const MIN_BODY_CHARS = 150;
const MARKER_RESERVE = 90;
const FILE_HEADER_RESERVE = 80;

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

interface Entry {
  node: GraphNode;
  rank: number;
}

function truncationMarker(more: number): string {
  return `… truncated (${more} more lines) — call graph_node for the full body`;
}

function linesWithin(lines: string[], maxChars: number): number {
  let used = 0;
  let kept = 0;
  for (const line of lines) {
    const cost = line.length + (kept > 0 ? 1 : 0);
    if (kept > 0 && used + cost > maxChars) break;
    used += cost;
    kept++;
  }
  return kept;
}

function buildSnippets(
  reader: SourceReader,
  filePath: string,
  entries: Entry[],
  fileBudget: number,
): ExploreSnippet[] {
  const ordered = [...entries].sort(
    (a, b) => a.rank - b.rank || a.node.startLine - b.node.startLine,
  );
  let remaining = fileBudget;
  let namedLeft = ordered.filter((e) => e.rank === 0).length;
  const shown: { start: number; end: number }[] = [];
  const snippets: ExploreSnippet[] = [];
  for (const { node, rank } of ordered) {
    if (rank === 0) namedLeft--;
    const r = reader.read(filePath, node.startLine, node.endLine);
    if (!r.ok) {
      const first = ordered[0]?.node.startLine ?? node.startLine;
      return [{ startLine: first, endLine: first, text: r.note }];
    }
    if (shown.some((s) => r.startLine >= s.start && node.endLine <= s.end))
      continue;
    const allowance =
      rank === 0
        ? Math.max(MIN_BODY_CHARS, Math.floor(remaining / (namedLeft + 1)))
        : remaining;
    if (rank !== 0 && allowance < MIN_BODY_CHARS) continue;
    const fullEnd = r.endLine + r.moreLines;
    const lines = r.text.split('\n');
    let kept = lines.length;
    if (r.text.length > allowance || r.moreLines > 0) {
      const budget = r.text.length > allowance ? allowance - MARKER_RESERVE : r.text.length;
      kept = Math.min(lines.length, linesWithin(lines, Math.max(budget, 0)));
    }
    const endLine = r.startLine + kept - 1;
    const body = lines.slice(0, kept).join('\n');
    const text =
      endLine < fullEnd
        ? `${body}\n${truncationMarker(fullEnd - endLine)}`
        : body;
    snippets.push({ startLine: r.startLine, endLine, text });
    shown.push({ start: r.startLine, end: endLine });
    remaining = Math.max(0, remaining - text.length - 1);
  }
  return snippets.sort((a, b) => a.startLine - b.startLine);
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

  const byFile = new Map<string, Map<string, Entry>>();
  const addAll = (nodes: GraphNode[], rank: number): void => {
    for (const n of nodes) {
      let m = byFile.get(n.filePath);
      if (!m) byFile.set(n.filePath, (m = new Map()));
      const prev = m.get(n.id);
      if (!prev || prev.rank > rank) m.set(n.id, { node: n, rank });
    }
  };
  addAll(namedNodes, 0);
  addAll(flowNodes, 1);
  addAll(neighbourNodes, 2);

  const budget = getExploreOutputBudget(db.counts().files);
  const maxFiles = opts.budgetFiles ?? budget.maxFiles;
  const allPaths = [...byFile.keys()];
  const isNamedFile = (p: string): boolean =>
    [...(byFile.get(p)?.values() ?? [])].some((e) => e.rank === 0);
  const namedPaths = allPaths.filter(isNamedFile);
  const extraPaths = allPaths.filter((p) => !isNamedFile(p));
  const extraCap = Math.max(0, maxFiles - namedPaths.length);
  const orderedPaths = [...namedPaths, ...extraPaths.slice(0, extraCap)];

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
  const namedShare = Math.floor(
    (remaining * 0.9) / Math.max(1, namedPaths.length) - FILE_HEADER_RESERVE,
  );
  const namedFileBudget = Math.min(
    budget.maxCharsPerFile,
    Math.max(MIN_BODY_CHARS, namedShare),
  );

  const reader = createSourceReader(root);
  const files: ExploreFile[] = [];
  const sourceParts: string[] = [];
  const omitted: string[] = [];
  for (const filePath of orderedPaths) {
    const named = isNamedFile(filePath);
    const fileBudget = named
      ? namedFileBudget
      : Math.min(budget.maxCharsPerFile, remaining - FILE_HEADER_RESERVE);
    if (fileBudget < MIN_BODY_CHARS) {
      omitted.push(filePath);
      continue;
    }
    const snippets = buildSnippets(
      reader,
      filePath,
      [...(byFile.get(filePath)?.values() ?? [])],
      fileBudget,
    );
    if (snippets.length === 0) continue;
    files.push({ path: filePath, snippets });
    const block = [
      `### ${filePath}`,
      ...snippets.flatMap((s) => [`lines ${s.startLine}-${s.endLine}`, fenced(s.text)]),
    ].join('\n');
    sourceParts.push(block);
    remaining -= block.length + 1;
  }

  const tail: string[] = [];
  const notShown = [...omitted, ...extraPaths.slice(extraCap)];
  if (notShown.length > 0) {
    tail.push(
      `More relevant files not shown: ${notShown.slice(0, 8).join(', ')}. Call \`graph_node\` on a symbol from them for its full body.`,
    );
  }
  const droppedNamed = hits.flatMap((r) => r.nodes).length - namedNodes.length;
  if (droppedNamed > 0)
    tail.push(
      `${droppedNamed} more matches for the named symbols were not expanded. Call \`graph_explore\` with a more specific name (\`Class.method\` or \`file.ts#name\`).`,
    );

  const markdown = [...headParts, ...sourceParts, ...tail].join('\n');
  return { flow, files, unresolvedNames, markdown, found: hits.length };
}
