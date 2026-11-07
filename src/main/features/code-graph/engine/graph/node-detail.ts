import type {
  GraphNode,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import type { GraphQueries } from '../db/queries';
import { readSourceRange } from './source-reader';
import { getCallees, getCallers, type TraversalHit } from './traversal';
import { lookupSymbol } from './symbol-lookup';

const TRAIL_LIMIT = 10;

export interface NodeMatch {
  node: GraphNode;
  location: string;
  signature?: string;
  docstring?: string;
  isExported: boolean;
  body: string;
  callers: TraversalHit[];
  callees: TraversalHit[];
  members: { name: string; kind: NodeKind }[];
}

export interface NodeDetail {
  found: boolean;
  matches: NodeMatch[];
  markdown: string;
}

function trail(hits: TraversalHit[]): string {
  if (hits.length === 0) return '-';
  return hits
    .map((h) => `${h.node.qualifiedName} (${h.node.filePath}:${h.node.startLine})`)
    .join(', ');
}

function renderMatch(m: NodeMatch): string {
  const n = m.node;
  const out = [`### ${n.qualifiedName} (${n.kind}) — ${m.location}`];
  out.push(m.isExported ? 'exported' : 'not exported');
  if (m.signature) out.push(`Signature: \`${m.signature}\``);
  if (m.docstring) out.push(`Doc: ${m.docstring}`);
  out.push('```', m.body, '```');
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
    return { found: false, matches: [], markdown: notFoundMarkdown(query) };

  const matches = nodes.map((node): NodeMatch => {
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
      body: readSourceRange(root, node.filePath, node.startLine, node.endLine),
      callers: getCallers(db, node.id, { depth: 1, limit: TRAIL_LIMIT }),
      callees: getCallees(db, node.id, { depth: 1, limit: TRAIL_LIMIT }),
      members,
    };
  });

  const head =
    matches.length > 1
      ? `## ${query} — ${matches.length} matches\n\n`
      : '';
  return {
    found: true,
    matches,
    markdown: head + matches.map(renderMatch).join('\n\n'),
  };
}
