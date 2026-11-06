import type { Node, Tree } from 'web-tree-sitter';
import type {
  CodeGraphLanguage,
  GraphEdge,
  GraphNode,
} from '../../../../../shared/domain/code-graph';
import type { UnresolvedRef } from '../db/queries';

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
