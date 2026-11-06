import type { Node, Tree } from 'web-tree-sitter';
import type {
  CodeGraphLanguage,
  EdgeKind,
  GraphEdge,
  GraphNode,
  NodeKind,
  RefMetadata,
} from '../../../../../shared/domain/code-graph';
import type { UnresolvedRef } from '../db/queries';
import { makeNodeId } from './node-id';

export interface FileExtraction {
  nodes: GraphNode[];
  edges: GraphEdge[];
  unresolved: UnresolvedRef[];
  errors: string[];
}

export interface LanguageExtractor {
  language: CodeGraphLanguage;
  extensions: string[];
  extract(relPath: string, source: string, tree: Tree): FileExtraction;
}

export function nodeText(source: string, node: Node): string {
  return source.slice(node.startIndex, node.endIndex);
}

export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

export function findChildByType(node: Node, type: string): Node | undefined {
  for (const child of node.children) {
    if (child?.type === type) return child;
  }
  return undefined;
}

/** Return false from `visit` to skip the node's children. Iterative: deep ASTs must not blow the stack. */
export function walk(root: Node, visit: (node: Node) => boolean | void): void {
  const cursor = root.walk();
  try {
    let descend = visit(cursor.currentNode) !== false;
    for (;;) {
      if (descend && cursor.gotoFirstChild()) {
        descend = visit(cursor.currentNode) !== false;
        continue;
      }
      for (;;) {
        if (cursor.currentNode.id === root.id) return;
        if (cursor.gotoNextSibling()) break;
        if (!cursor.gotoParent()) return;
      }
      descend = visit(cursor.currentNode) !== false;
    }
  } finally {
    cursor.delete();
  }
}

export function nameTail(name: string): string {
  if (name.includes('/')) return name;
  return name.slice(name.lastIndexOf('.') + 1);
}

export function unquote(text: string): string {
  return /^(['"`]).*\1$/s.test(text) ? text.slice(1, -1) : text;
}

const MAX_SIGNATURE = 300;

/** Declaration header up to (not including) its body, whitespace collapsed. */
export function headerText(
  source: string,
  node: Node,
  body?: Node | null,
  start: number = node.startIndex,
): string {
  const end = body ? body.startIndex : node.endIndex;
  const text = source.slice(start, end).replace(/\s+/g, ' ').trim();
  return text.length > MAX_SIGNATURE ? `${text.slice(0, MAX_SIGNATURE)}…` : text;
}

export type SymbolInit = Omit<
  GraphNode,
  'id' | 'qualifiedName' | 'filePath' | 'language' | 'startLine' | 'endLine' | 'isExported'
> & {
  kind: NodeKind;
  syntax: Node;
  isExported?: boolean;
};

export interface Scope {
  node: GraphNode;
  endIndex: number;
}

/**
 * Per-file accumulator every language extractor uses: ids, `contains` edges, scoped qualified
 * names, unresolved refs and syntax errors. Scopes rely on `walk` visiting in document order.
 */
export class ExtractionBuilder {
  readonly file: GraphNode;
  private readonly nodes: GraphNode[] = [];
  private readonly byId = new Map<string, GraphNode>();
  private readonly edges: GraphEdge[] = [];
  private readonly unresolved: UnresolvedRef[] = [];
  private readonly errors: string[] = [];
  private readonly scopes: Scope[] = [];

  constructor(
    readonly relPath: string,
    readonly language: CodeGraphLanguage,
    root: Node,
  ) {
    this.file = {
      id: makeNodeId(relPath, 'file', relPath, 1),
      kind: 'file',
      name: relPath.slice(relPath.lastIndexOf('/') + 1),
      qualifiedName: relPath,
      filePath: relPath,
      language,
      startLine: 1,
      endLine: root.endPosition.row + 1,
      isExported: false,
    };
    this.nodes.push(this.file);
  }

  get result(): FileExtraction {
    return { nodes: this.nodes, edges: this.edges, unresolved: this.unresolved, errors: this.errors };
  }

  scopeAt(syntax: Node): Scope {
    let top = this.scopes[this.scopes.length - 1];
    while (top && syntax.startIndex >= top.endIndex) {
      this.scopes.pop();
      top = this.scopes[this.scopes.length - 1];
    }
    return top ?? { node: this.file, endIndex: Number.POSITIVE_INFINITY };
  }

  enterScope(syntax: Node, node: GraphNode): void {
    this.scopeAt(syntax);
    this.scopes.push({ node, endIndex: syntax.endIndex });
  }

  addSymbol(init: SymbolInit, parent: GraphNode): GraphNode {
    const { syntax, isExported, ...fields } = init;
    const qualifiedName = parent === this.file ? init.name : `${parent.qualifiedName}.${init.name}`;
    const startLine = lineOf(syntax);
    const id = makeNodeId(this.relPath, init.kind, qualifiedName, startLine);
    const existing = this.byId.get(id);
    if (existing) return existing;
    const node: GraphNode = {
      ...fields,
      id,
      qualifiedName,
      filePath: this.relPath,
      language: this.language,
      startLine,
      endLine: syntax.endPosition.row + 1,
      isExported: isExported ?? false,
    };
    this.nodes.push(node);
    this.byId.set(id, node);
    this.edges.push({ source: parent.id, target: id, kind: 'contains', provenance: 'static' });
    return node;
  }

  addRef(fromNodeId: string, referenceName: string, kind: EdgeKind, at: Node, metadata?: RefMetadata): void {
    const ref: UnresolvedRef = {
      fromNodeId,
      referenceName,
      referenceKind: kind,
      line: lineOf(at),
      col: at.startPosition.column,
      filePath: this.relPath,
      language: this.language,
      status: 'pending',
      nameTail: nameTail(referenceName),
    };
    if (metadata) ref.metadata = metadata;
    this.unresolved.push(ref);
  }

  addError(message: string): void {
    this.errors.push(`${this.relPath}: ${message}`);
  }

  /** Records ERROR and MISSING nodes; the caller keeps walking so the valid parts survive. */
  noteSyntaxError(syntax: Node): boolean {
    if (!syntax.isError && !syntax.isMissing) return false;
    const where = `${this.relPath}:${lineOf(syntax)}:${syntax.startPosition.column + 1}`;
    this.errors.push(syntax.isMissing ? `${where} missing ${syntax.type}` : `${where} syntax error`);
    return true;
  }
}
