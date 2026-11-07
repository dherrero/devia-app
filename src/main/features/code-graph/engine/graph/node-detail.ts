import type {
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';
import { fenced } from './fence';
import { createSourceReader, type RangeRead, type SourceReader } from './source-reader';
import { getCallees, getCallers, type TraversalHit } from './traversal';
import { lookupSymbol } from './symbol-lookup';

const TRAIL_LIMIT = 10;
const MAX_EXPANDED = 8;

export interface NodeMatch {
  node: GraphNode;
  location: string;
  signature?: string;
  docstring?: string;
  isExported: boolean;
  /** Full source, empty when `note` explains why it is unavailable. */
  body: string;
  note?: string;
  callers: TraversalHit[];
  callees: TraversalHit[];
  members: { name: string; kind: NodeKind }[];
}

export interface NodeDetail {
  found: boolean;
  matches: NodeMatch[];
  omitted: { qualifiedName: string; location: string }[];
  markdown: string;
}

function sourceText(
  r: Extract<RangeRead, { ok: true }>,
  node: GraphNode,
): string {
  const fullEnd = r.endLine + r.moreLines;
  return r.moreLines > 0 && fullEnd === node.endLine
    ? `${r.text}\n… truncated (${r.moreLines} more lines) — range capped at 400 lines`
    : r.text;
}

function trail(hits: TraversalHit[]): string {
  if (hits.length === 0) return '-';
  return hits
    .map((h) => `${h.node.qualifiedName} (${h.node.filePath}:${h.node.startLine})`)
    .join(', ');
}

function renderMatch(m: NodeMatch, notedFiles: Set<string>): string {
  const n = m.node;
  const out = [`### ${n.qualifiedName} (${n.kind}) — ${m.location}`];
  out.push(m.isExported ? 'exported' : 'not exported');
  if (m.signature) out.push(`Signature: \`${m.signature}\``);
  if (m.docstring) out.push(`Doc: ${m.docstring}`);
  if (m.note !== undefined) {
    out.push(
      notedFiles.has(m.node.filePath)
        ? '(source unavailable, see the note for this file above)'
        : `Note: ${m.note}`,
    );
    notedFiles.add(m.node.filePath);
  } else out.push(fenced(m.body));
  if (m.members.length > 0)
    out.push(
      `Members: ${m.members.map((x) => `${x.name} (${x.kind})`).join(', ')}`,
    );
  out.push(`Callers: ${trail(m.callers)}`);
  out.push(`Callees: ${trail(m.callees)}`);
  return out.join('\n');
}

function notFoundMarkdown(query: string): string {
  const shown = query.trim();
  return shown === ''
    ? 'No symbol given. Call `graph_explore` with one or more symbol names, or `graph_node` with an exact name.'
    : `No symbol named \`${shown}\` in the code graph. Try \`graph_explore\` with related names (also \`Class.method\` or \`file.ts#name\`), or check the spelling; if the file is new, run graph_status to see whether the index is up to date.`;
}

/** Every match (overloads included) of a name or node id, with full body and a short call trail. */
export function getNodeDetail(
  db: GraphQueries,
  root: string,
  nameOrId: string,
): NodeDetail {
  const query = nameOrId.trim();
  const byId = query === '' ? undefined : db.nodeById(query);
  const nodes = byId ? [byId] : lookupSymbol(db, query);
  if (nodes.length === 0)
    return {
      found: false,
      matches: [],
      omitted: [],
      markdown: notFoundMarkdown(query),
    };

  const reader: SourceReader = createSourceReader(root);
  const expanded = nodes.slice(0, MAX_EXPANDED);
  const omitted = nodes.slice(MAX_EXPANDED).map((n) => ({
    qualifiedName: n.qualifiedName,
    location: `${n.filePath}:${n.startLine}`,
  }));
  const matches = expanded.map((node): NodeMatch => {
    const r = reader.read(node.filePath, node.startLine, node.endLine);
    const members = db
      .edgesFrom(node.id, ['contains'])
      .flatMap((e) => db.nodeById(e.target) ?? [])
      .map((c) => ({ name: c.name, kind: c.kind }));
    return {
      node,
      location: `${node.filePath}:${node.startLine}`,
      ...(node.signature !== undefined && { signature: node.signature }),
      ...(node.docstring !== undefined && { docstring: node.docstring }),
      isExported: node.isExported,
      body: r.ok ? sourceText(r, node) : '',
      ...(!r.ok && { note: r.note }),
      callers: getCallers(db, node.id, { depth: 1, limit: TRAIL_LIMIT }),
      callees: getCallees(db, node.id, { depth: 1, limit: TRAIL_LIMIT }),
      members,
    };
  });

  const heading =
    nodes.length > 1 ? `## ${query} — ${nodes.length} matches\n\n` : '';
  const notedFiles = new Set<string>();
  const parts = matches.map((m) => renderMatch(m, notedFiles));
  if (omitted.length > 0)
    parts.push(
      `${omitted.length} more matches not expanded (use \`file.ts#name\` or \`Class.method\` to pick one): ${omitted.map((o) => o.location).join(', ')}`,
    );
  return {
    found: true,
    matches,
    omitted,
    markdown: heading + parts.join('\n\n'),
  };
}
