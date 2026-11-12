import type { Node } from 'web-tree-sitter';

// Locals and parameters in scope while an extractor walks a file in document order (S-44 T-515).
// They are not graph nodes, so their receiver facts are tracked here and land on the refs that
// use them. Shared by every language; each language decides what declares a local and its fact.

export interface Local {
  name: string;
  /** TypeExpr, or undefined when the type is unknown (the local still shadows outer names). */
  fact: string | undefined;
  start: number;
  end: number;
}

export class ScopeStack {
  private readonly stack: Local[] = [];

  /** Visible from `from` (default: the start of `scope`) to the end of `scope`. */
  declare(name: string, fact: string | undefined, scope: Node, from: number = scope.startIndex): void {
    this.prune(from);
    this.stack.push({ name, fact, start: from, end: scope.endIndex });
  }

  /** The innermost local named `name` visible at `at`, if any. */
  find(name: string, at: Node): Local | undefined {
    this.prune(at.startIndex);
    const pos = at.startIndex;
    for (let i = this.stack.length - 1; i >= 0; i--) {
      const l = this.stack[i];
      if (l && l.name === name && l.start <= pos && pos < l.end) return l;
    }
    return undefined;
  }

  private prune(pos: number): void {
    for (let top = this.stack[this.stack.length - 1]; top && top.end <= pos; top = this.stack[this.stack.length - 1])
      this.stack.pop();
  }
}

