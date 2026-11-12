import * as path from 'node:path';
import type {
  CodeGraphLanguage,
  GraphEdge,
  NodeKind,
} from '../../../../../shared/domain/code-graph';
import type { NodeSummary } from '../db/queries';

// Name lookup over an in-memory index built once per resolution run (no per-reference queries).
// Every lookup returns the candidate list after scoping and overload collapsing: empty = not
// found, one = resolved, more = ambiguous (the caller then refuses to guess).

const NOT_SYMBOLS: ReadonlySet<NodeKind> = new Set([
  'file',
  'import',
  'export',
  'module',
  'parameter',
]);
const MEMBER_KINDS: ReadonlySet<NodeKind> = new Set([
  'method',
  'property',
  'field',
  'enum_member',
]);
const TOP_CONTAINERS: ReadonlySet<NodeKind> = new Set([
  'file',
  'module',
  'namespace',
]);
/** Languages where a bare name inside a class body sees the class's (and inherited) members. */
const CLASS_SCOPED: ReadonlySet<CodeGraphLanguage> = new Set(['java', 'dart']);
const MAX_SUPER_DEPTH = 10;
const EMPTY_SET: ReadonlySet<string> = new Set();
/** Above this many nodes the project-wide name index is not built (memory guard). */
export const MAX_GLOBAL_INDEX_NODES = 1_000_000;

export function languageFamily(lang: CodeGraphLanguage): string {
  return lang === 'javascript' ? 'typescript' : lang;
}

export function isClassLike(n: NodeSummary): boolean {
  return (
    n.kind === 'class' ||
    n.kind === 'interface' ||
    n.kind === 'enum' ||
    (n.kind === 'component' && n.language === 'dart')
  );
}

export function isConstructor(n: NodeSummary): boolean {
  return n.metadata?.['constructor'] === true;
}

function dirOf(file: string): string {
  const d = path.posix.dirname(file);
  return d === '.' ? '' : d;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export class SymbolIndex {
  readonly byId = new Map<string, NodeSummary>();
  readonly fileNodes = new Map<string, NodeSummary>();
  private readonly byFile = new Map<string, NodeSummary[]>();
  private readonly byFileName = new Map<string, Map<string, NodeSummary[]>>();
  private readonly byName: Map<string, NodeSummary[]> | undefined;
  private readonly parent = new Map<string, string>();
  private readonly children = new Map<string, NodeSummary[]>();
  private readonly supers = new Map<string, string[]>();
  private readonly importsOf = new Map<string, Set<string>>();
  private readonly exportsOf = new Map<string, Set<string>>();
  private readonly byDir = new Map<string, string[]>();

  constructor(
    nodes: NodeSummary[],
    edges: GraphEdge[],
    files: Iterable<string>,
  ) {
    for (const n of nodes) {
      this.byId.set(n.id, n);
      if (n.kind === 'file') this.fileNodes.set(n.filePath, n);
      push(this.byFile, n.filePath, n);
      if (NOT_SYMBOLS.has(n.kind)) continue;
      let names = this.byFileName.get(n.filePath);
      if (!names) this.byFileName.set(n.filePath, (names = new Map()));
      push(names, n.name, n);
    }
    for (const f of files) push(this.byDir, dirOf(f), f);
    if (nodes.length <= MAX_GLOBAL_INDEX_NODES) {
      this.byName = new Map();
      for (const n of nodes)
        if (!NOT_SYMBOLS.has(n.kind)) push(this.byName, n.name, n);
    }
    for (const e of edges) {
      if (e.kind === 'contains') {
        const child = this.byId.get(e.target);
        if (!child) continue;
        this.parent.set(e.target, e.source);
        push(this.children, e.source, child);
      } else if (e.kind === 'extends' || e.kind === 'implements') {
        this.addSupertype(e.source, e.target);
      } else if (e.kind === 'imports') {
        const from = this.byId.get(e.source);
        const to = this.byId.get(e.target);
        if (from?.kind === 'file' && to?.kind === 'file')
          this.addImport(from.filePath, to.filePath);
      } else if (e.kind === 'exports') {
        const from = this.byId.get(e.source);
        const to = this.byId.get(e.target);
        if (from?.kind === 'file' && to?.kind === 'file')
          this.addExport(from.filePath, to.filePath);
      }
    }
  }

  addSupertype(sub: string, sup: string): void {
    const list = this.supers.get(sub);
    if (!list) this.supers.set(sub, [sup]);
    else if (!list.includes(sup)) list.push(sup);
  }

  addImport(from: string, to: string): void {
    let set = this.importsOf.get(from);
    if (!set) this.importsOf.set(from, (set = new Set()));
    set.add(to);
  }

  addExport(from: string, to: string): void {
    let set = this.exportsOf.get(from);
    if (!set) this.exportsOf.set(from, (set = new Set()));
    set.add(to);
  }

  imports(file: string, target: string): boolean {
    return this.importsOf.get(file)?.has(target) === true;
  }

  importedFiles(file: string): ReadonlySet<string> {
    return this.importsOf.get(file) ?? EMPTY_SET;
  }

  exportedFiles(file: string): ReadonlySet<string> {
    return this.exportsOf.get(file) ?? EMPTY_SET;
  }

  nodesInFile(file: string): NodeSummary[] {
    return this.byFile.get(file) ?? [];
  }

  hasLanguage(lang: CodeGraphLanguage): boolean {
    for (const n of this.fileNodes.values())
      if (n.language === lang) return true;
    return false;
  }

  filesInDir(dir: string): string[] {
    return this.byDir.get(dir) ?? [];
  }

  parentOf(n: NodeSummary): NodeSummary | undefined {
    const id = this.parent.get(n.id);
    return id === undefined ? undefined : this.byId.get(id);
  }

  childrenOf(n: NodeSummary): NodeSummary[] {
    return this.children.get(n.id) ?? [];
  }

  /** Python's `module` node stands in for its file: both are the module scope. */
  private scopeOf(n: NodeSummary): NodeSummary {
    if (n.kind !== 'module') return n;
    return this.fileNodes.get(n.filePath) ?? n;
  }

  private canonicalParent(n: NodeSummary): NodeSummary | undefined {
    const p = this.parentOf(n);
    return p ? this.scopeOf(p) : undefined;
  }

  /** `from` and its `contains` ancestors, innermost first. */
  ancestors(from: NodeSummary): NodeSummary[] {
    const chain: NodeSummary[] = [];
    const seen = new Set<string>();
    for (
      let n: NodeSummary | undefined = from;
      n && !seen.has(n.id);
      n = this.parentOf(n)
    ) {
      seen.add(n.id);
      const scope = this.scopeOf(n);
      if (chain[chain.length - 1]?.id !== scope.id) chain.push(scope);
    }
    const file = this.fileNodes.get(from.filePath);
    if (file && chain[chain.length - 1]?.id !== file.id) chain.push(file);
    return chain;
  }

  enclosingClass(from: NodeSummary): NodeSummary | undefined {
    return this.ancestors(from).find((n) => isClassLike(n));
  }

  isTopLevel(n: NodeSummary): boolean {
    const p = this.parentOf(n);
    return !p || TOP_CONTAINERS.has(p.kind);
  }

  /** A bare `name` seen from `from`: innermost lexical scope first, then (Java/Dart) class members. */
  scopeLookup(name: string, from: NodeSummary): NodeSummary[] {
    const candidates = (
      this.byFileName.get(from.filePath)?.get(name) ?? []
    ).filter((c) => !isConstructor(c));
    const classScoped = CLASS_SCOPED.has(from.language);
    for (const scope of this.ancestors(from)) {
      const scopeIsClass = isClassLike(scope);
      if (scopeIsClass && !classScoped) continue;
      const hits = candidates.filter((c) => {
        if (this.canonicalParent(c)?.id !== scope.id) return false;
        return !MEMBER_KINDS.has(c.kind) || scopeIsClass;
      });
      if (hits.length > 0) return collapseOverloads(hits);
      if (scopeIsClass) {
        const inherited = this.inheritedMember(scope, name);
        if (inherited.length > 0) return inherited;
      }
    }
    return [];
  }

  /** `seg` as a member of `owner`, including Dart named constructors, Go methods declared in sibling files and inherited members. */
  memberOf(owner: NodeSummary, seg: string): NodeSummary[] {
    const direct = this.directMembers(owner, seg);
    if (direct.length > 0) return direct;
    return this.inheritedMember(owner, seg);
  }

  private directMembers(owner: NodeSummary, seg: string): NodeSummary[] {
    const named = `${owner.name}.${seg}`;
    const hits = this.childrenOf(owner).filter(
      (c) => c.name === seg || (c.language === 'dart' && c.name === named),
    );
    if (hits.length === 0 && owner.language === 'go' && isClassLike(owner)) {
      const qualified = `${owner.name}.${seg}`;
      for (const file of this.filesInDir(dirOf(owner.filePath))) {
        for (const c of this.byFileName.get(file)?.get(seg) ?? []) {
          if (c.kind === 'method' && c.qualifiedName === qualified)
            hits.push(c);
        }
      }
    }
    return collapseOverloads(hits);
  }

  supertypesOf(n: NodeSummary): NodeSummary[] {
    return (this.supers.get(n.id) ?? []).flatMap((id) => {
      const s = this.byId.get(id);
      return s ? [s] : [];
    });
  }

  /** Breadth-first over resolved `extends`/`implements`; the nearest level that has the member wins. */
  inheritedMember(owner: NodeSummary, seg: string): NodeSummary[] {
    const seen = new Set<string>([owner.id]);
    let level = this.supertypesOf(owner);
    for (let depth = 0; depth < MAX_SUPER_DEPTH && level.length > 0; depth++) {
      const hits: NodeSummary[] = [];
      const next: NodeSummary[] = [];
      for (const s of level) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        hits.push(...this.directMembers(s, seg));
        next.push(...this.supertypesOf(s));
      }
      if (hits.length > 0) return collapseOverloads(hits);
      level = next;
    }
    return [];
  }

  /**
   * Project-wide top-level symbols named `name` in the same language family. Go only looks in
   * the caller's package directory: other packages always need a qualifier.
   */
  projectLookup(name: string, from: NodeSummary): NodeSummary[] {
    if (!this.byName) return [];
    const family = languageFamily(from.language);
    const goDir = from.language === 'go' ? dirOf(from.filePath) : undefined;
    const candidates = (this.byName.get(name) ?? []).filter(
      (c) =>
        languageFamily(c.language) === family &&
        !MEMBER_KINDS.has(c.kind) &&
        !isConstructor(c) &&
        this.isTopLevel(c) &&
        (goDir === undefined || dirOf(c.filePath) === goDir),
    );
    return this.tieBreak(collapseOverloads(candidates), from.filePath);
  }

  /** Only same file, same directory, then files the caller imports; otherwise still ambiguous. */
  tieBreak(candidates: NodeSummary[], file: string): NodeSummary[] {
    let current = candidates;
    const imported = this.importsOf.get(file);
    const criteria: ((c: NodeSummary) => boolean)[] = [
      (c) => c.filePath === file,
      (c) => dirOf(c.filePath) === dirOf(file),
      (c) => imported?.has(c.filePath) === true,
    ];
    for (const keep of criteria) {
      if (current.length <= 1) return current;
      const narrowed = current.filter(keep);
      if (narrowed.length > 0) current = narrowed;
    }
    return current;
  }
}

/**
 * Java keeps methods and fields in separate namespaces (`events` field next to `events()`): a
 * call position wants the method, a receiver or value position the field. Other languages, and
 * `call` undefined (position unknown), keep every hit.
 */
export function byNamespace(hits: NodeSummary[], call: boolean | undefined): NodeSummary[] {
  if (hits.length < 2 || call === undefined || hits[0]?.language !== 'java') return hits;
  const narrowed = hits.filter((h) => (h.kind === 'method') === call);
  return narrowed.length > 0 ? narrowed : hits;
}

/**
 * Overloads (same file, kind and qualified name) are one symbol. Keep the largest span, and on a
 * tie the last one: TS overload signatures precede their implementation.
 */
export function collapseOverloads(nodes: NodeSummary[]): NodeSummary[] {
  if (nodes.length <= 1) return nodes;
  const groups = new Map<string, NodeSummary>();
  for (const n of nodes) {
    const key = `${n.filePath}\0${n.kind}\0${n.qualifiedName}`;
    const prev = groups.get(key);
    const span = n.endLine - n.startLine;
    const prevSpan = prev ? prev.endLine - prev.startLine : -1;
    if (
      !prev ||
      span > prevSpan ||
      (span === prevSpan && n.startLine > prev.startLine)
    )
      groups.set(key, n);
  }
  return [...groups.values()];
}
