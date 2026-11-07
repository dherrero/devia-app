import * as path from 'node:path';
import {
  EDGE_KINDS,
  type CodeGraphLanguage,
  type EdgeKind,
  type GraphEdge,
} from '../../../../../shared/domain/code-graph';
import type { GraphQueries, NodeSummary, UnresolvedRef } from '../db/queries';
import { resolverFor, type ResolveContext } from './language-resolvers';
import {
  collapseOverloads,
  isClassLike,
  isConstructor,
  SymbolIndex,
} from './name-matcher';

// Adapted from codegraph (MIT), src/resolution/index.ts, without frameworks or synthesizers.
//
// Phases run in order so later ones can lean on earlier edges: imports (file→file edges and
// per-file bindings) → extends/implements (supertypes for inherited members) → calls and the
// rest → overrides. Silence beats a wrong edge: anything ambiguous is marked `failed`.

export interface ResolveStats {
  resolved: number;
  failed: number;
}

const BATCH_SIZE = 500;
const MAX_EXPORT_DEPTH = 8;

const IMPORT_KINDS: EdgeKind[] = ['imports', 'exports'];
const HERITAGE_KINDS: EdgeKind[] = ['extends', 'implements'];
const LATE_KINDS: EdgeKind[] = ['overrides'];
const SYMBOL_KINDS: EdgeKind[] = EDGE_KINDS.filter(
  (k) =>
    k !== 'contains' &&
    !IMPORT_KINDS.includes(k) &&
    !HERITAGE_KINDS.includes(k) &&
    !LATE_KINDS.includes(k),
);
const PHASES: EdgeKind[][] = [
  IMPORT_KINDS,
  HERITAGE_KINDS,
  SYMBOL_KINDS,
  LATE_KINDS,
];

const GO_BUILTINS: ReadonlySet<string> = new Set(
  (
    'append len cap make new copy delete panic recover print println close min max clear complex real imag ' +
    'int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 uintptr float32 float64 string bool byte rune error any'
  ).split(' '),
);

const RECEIVER_WORDS: Readonly<
  Partial<Record<CodeGraphLanguage, ReadonlySet<string>>>
> = {
  typescript: new Set(['this']),
  javascript: new Set(['this']),
  java: new Set(['this']),
  dart: new Set(['this']),
  python: new Set(['self', 'cls']),
};
const SUPER_LANGUAGES: ReadonlySet<CodeGraphLanguage> = new Set([
  'typescript',
  'javascript',
  'java',
  'dart',
]);
const CALLABLE_TARGETS: ReadonlySet<string> = new Set([
  'function',
  'method',
  'component',
  'class',
  'variable',
  'constant',
  'property',
  'field',
]);
const TYPE_TARGETS: ReadonlySet<string> = new Set([
  'class',
  'interface',
  'type_alias',
  'component',
  'enum',
]);
const NON_TARGETS: ReadonlySet<string> = new Set([
  'file',
  'import',
  'export',
  'module',
  'parameter',
]);

type Binding =
  | { kind: 'symbol'; node: NodeSummary }
  | { kind: 'namespace'; files: string[] }
  | { kind: 'blocked' };
type ExportTarget =
  | { kind: 'symbol'; node: NodeSummary }
  | { kind: 'namespace'; files: string[] };

interface Resolution {
  target: NodeSummary;
  heuristic: boolean;
}

interface BatchWrites {
  edges: GraphEdge[];
  deletes: number[];
  fails: { id: number; tail: string }[];
}

/**
 * Turns `pending` unresolved refs into edges. With `onlyFiles`, only the refs of those files
 * plus `failed` refs elsewhere whose name tail matches something those files define (so a new
 * file can satisfy old references). Idempotent: resolved refs are deleted and edges are unique.
 */
export function resolveReferences(
  db: GraphQueries,
  root: string,
  onlyFiles?: string[],
): ResolveStats {
  return new ResolutionRun(db, root).run(onlyFiles);
}

class ResolutionRun {
  private readonly index: SymbolIndex;
  private readonly ctx: ResolveContext;
  private readonly bindings = new Map<string, Map<string, Binding>>();
  private readonly esModules = new Map<string, boolean>();
  private readonly goReceivers = new Map<
    string,
    { name: string; type: NodeSummary } | null
  >();
  private readonly stats: ResolveStats = { resolved: 0, failed: 0 };

  constructor(
    private readonly db: GraphQueries,
    root: string,
  ) {
    const files = db.filePaths();
    const fileSet = new Set(files);
    this.ctx = {
      root,
      fileExists: (rel) => fileSet.has(rel),
      listFiles: () => files,
    };
    this.index = new SymbolIndex(
      db.nodeSummaries(),
      db.edgesOfKinds(['contains', 'extends', 'implements', 'imports']),
      files,
    );
  }

  run(onlyFiles: string[] | undefined): ResolveStats {
    if (onlyFiles === undefined) {
      for (const kinds of PHASES)
        this.processAll(this.db.unresolvedByKinds('pending', kinds));
    } else {
      const refs = this.selectForFiles(onlyFiles);
      for (const kinds of PHASES)
        this.processAll(refs.filter((r) => kinds.includes(r.referenceKind)));
    }
    return this.stats;
  }

  private selectForFiles(onlyFiles: string[]): UnresolvedRef[] {
    const tails = new Set<string>();
    for (const file of onlyFiles) {
      tails.add(fileStem(file));
      const dir = path.posix.basename(path.posix.dirname(file));
      if (dir && dir !== '.') tails.add(dir);
      for (const n of this.index.nodesInFile(file))
        if (!NON_TARGETS.has(n.kind)) tails.add(n.name);
    }
    const retried = this.db.failedByNameTails([...tails]);
    const touched = new Set([...onlyFiles, ...retried.map((r) => r.filePath)]);
    // Bindings live on import refs; reload the failed ones of every touched file so retried calls see them.
    const imports = this.db
      .unresolvedInFiles([...touched], 'failed')
      .filter((r) => IMPORT_KINDS.includes(r.referenceKind));
    const byId = new Map<number, UnresolvedRef>();
    for (const r of [
      ...this.db.unresolvedInFiles(onlyFiles, 'pending'),
      ...retried,
      ...imports,
    ]) {
      if (r.id !== undefined) byId.set(r.id, r);
    }
    const refs = [...byId.values()].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    this.db.transaction(() => {
      for (const r of refs)
        if (r.status === 'failed' && r.id !== undefined)
          this.db.markUnresolved(r.id, 'pending');
    });
    return refs;
  }

  private processAll(refs: UnresolvedRef[]): void {
    for (let start = 0; start < refs.length; start += BATCH_SIZE) {
      const writes: BatchWrites = { edges: [], deletes: [], fails: [] };
      for (const ref of refs.slice(start, start + BATCH_SIZE))
        this.processRef(ref, writes);
      this.db.transaction(() => {
        this.db.insertEdges(writes.edges);
        for (const id of writes.deletes) this.db.deleteUnresolved(id);
        for (const f of writes.fails)
          this.db.markUnresolved(f.id, 'failed', f.tail);
      });
    }
  }

  private processRef(ref: UnresolvedRef, writes: BatchWrites): void {
    if (ref.id === undefined) return;
    const from = this.index.byId.get(ref.fromNodeId);
    if (!from) {
      writes.deletes.push(ref.id);
      return;
    }
    if (IMPORT_KINDS.includes(ref.referenceKind)) {
      this.processImport(ref, ref.id, writes);
      return;
    }
    if (isDroppedBuiltin(ref)) {
      writes.deletes.push(ref.id);
      return;
    }
    const edge = this.resolveSymbolRef(ref, from);
    if (!edge) {
      writes.fails.push({ id: ref.id, tail: ref.nameTail });
      this.stats.failed++;
      return;
    }
    writes.edges.push(edge);
    writes.deletes.push(ref.id);
    this.stats.resolved++;
    if (edge.kind === 'extends' || edge.kind === 'implements')
      this.index.addSupertype(edge.source, edge.target);
  }

  private processImport(
    ref: UnresolvedRef,
    id: number,
    writes: BatchWrites,
  ): void {
    const fail = (tail: string): void => {
      writes.fails.push({ id, tail });
      this.stats.failed++;
    };
    const meta = ref.metadata ?? {};
    const bindingName =
      typeof meta['binding'] === 'string' ? meta['binding'] : undefined;
    const resolver = resolverFor(ref.language);
    if (!resolver) {
      fail(importStem(ref.referenceName));
      return;
    }
    const target = resolver.resolveImport(
      ref.filePath,
      ref.referenceName,
      this.ctx,
    );
    const targetFile =
      target === undefined ? undefined : this.index.fileNodes.get(target);
    const sourceFile = this.index.fileNodes.get(ref.filePath);
    if (target === undefined || !targetFile || !sourceFile) {
      if (bindingName)
        this.bind(ref.filePath, bindingName, { kind: 'blocked' });
      fail(importStem(ref.referenceName));
      return;
    }
    if (target !== ref.filePath) {
      writes.edges.push({
        source: sourceFile.id,
        target: targetFile.id,
        kind: ref.referenceKind,
        provenance: 'static',
      });
      if (ref.referenceKind === 'imports')
        this.index.addImport(ref.filePath, target);
    }
    if (!bindingName) {
      writes.deletes.push(id);
      this.stats.resolved++;
      return;
    }
    const imported =
      typeof meta['imported'] === 'string' ? meta['imported'] : undefined;
    let binding: Binding | undefined;
    if (
      meta['star'] === true ||
      (imported === undefined && ref.language !== 'java')
    ) {
      binding = {
        kind: 'namespace',
        files: this.namespaceFiles(target, ref.language),
      };
    } else {
      binding = this.findExport(target, imported ?? bindingName, 0, new Set());
    }
    if (!binding) {
      this.bind(ref.filePath, bindingName, { kind: 'blocked' });
      fail(imported ?? bindingName);
      return;
    }
    this.bind(ref.filePath, bindingName, binding);
    writes.deletes.push(id);
    this.stats.resolved++;
  }

  private bind(file: string, name: string, binding: Binding): void {
    let map = this.bindings.get(file);
    if (!map) this.bindings.set(file, (map = new Map()));
    map.set(name, binding);
  }

  /** A Go package is its directory; everywhere else a namespace import is one file. */
  private namespaceFiles(target: string, lang: CodeGraphLanguage): string[] {
    if (lang !== 'go') return [target];
    const dir = path.posix.dirname(target);
    return this.index.filesInDir(dir === '.' ? '' : dir);
  }

  /** What `name` exported from `file` is: TS export nodes (local, re-export, `*`), `default`, or a top-level symbol. */
  private findExport(
    file: string,
    name: string,
    depth: number,
    seen: Set<string>,
  ): ExportTarget | undefined {
    const key = `${file}\0${name}`;
    if (depth > MAX_EXPORT_DEPTH || seen.has(key)) return undefined;
    seen.add(key);
    const nodes = this.index.nodesInFile(file);
    const topLevel = (n: NodeSummary): boolean =>
      !NON_TARGETS.has(n.kind) && !isConstructor(n) && this.index.isTopLevel(n);

    for (const e of nodes) {
      if (e.kind !== 'export' || e.name !== name) continue;
      const local = e.metadata?.['local'];
      const source = e.metadata?.['source'];
      if (typeof local === 'string') {
        const hits = collapseOverloads(
          nodes.filter((n) => topLevel(n) && n.name === local),
        );
        if (hits.length === 1 && hits[0])
          return { kind: 'symbol', node: hits[0] };
      } else if (typeof source === 'string') {
        const next = resolverFor(e.language)?.resolveImport(
          file,
          source,
          this.ctx,
        );
        if (next === undefined) return undefined;
        const imported = e.metadata?.['imported'];
        if (typeof imported !== 'string')
          return { kind: 'namespace', files: [next] };
        return this.findExport(next, imported, depth + 1, seen);
      }
    }

    if (name === 'default') {
      const hits = collapseOverloads(
        nodes.filter(
          (n) => topLevel(n) && n.metadata?.['exportDefault'] === true,
        ),
      );
      if (hits.length === 1 && hits[0])
        return { kind: 'symbol', node: hits[0] };
    }
    const named = nodes.filter((n) => topLevel(n) && n.name === name);
    const exported = named.filter((n) => n.isExported);
    const hits = collapseOverloads(exported.length > 0 ? exported : named);
    if (hits.length === 1 && hits[0]) return { kind: 'symbol', node: hits[0] };
    if (hits.length > 1) return undefined;

    const found = new Map<string, ExportTarget>();
    for (const e of nodes) {
      const source = e.metadata?.['source'];
      if (e.kind !== 'export' || e.name !== '*' || typeof source !== 'string')
        continue;
      const next = resolverFor(e.language)?.resolveImport(
        file,
        source,
        this.ctx,
      );
      const hit =
        next === undefined
          ? undefined
          : this.findExport(next, name, depth + 1, seen);
      if (hit?.kind === 'symbol') found.set(hit.node.id, hit);
    }
    return found.size === 1 ? [...found.values()][0] : undefined;
  }

  private resolveSymbolRef(
    ref: UnresolvedRef,
    from: NodeSummary,
  ): GraphEdge | undefined {
    if (ref.referenceKind === 'overrides')
      return this.resolveOverride(ref, from);
    const resolution = this.resolveName(ref.referenceName, from);
    if (!resolution) return undefined;
    const shaped = shapeEdge(ref.referenceKind, resolution.target, this.index);
    if (!shaped) return undefined;
    const edge: GraphEdge =
      ref.referenceKind === 'decorates'
        ? { source: shaped.target.id, target: from.id, kind: 'decorates' }
        : { source: from.id, target: shaped.target.id, kind: shaped.kind };
    edge.line = ref.line;
    edge.provenance = resolution.heuristic ? 'heuristic' : 'static';
    return edge;
  }

  private resolveOverride(
    ref: UnresolvedRef,
    from: NodeSummary,
  ): GraphEdge | undefined {
    const owner = this.index.parentOf(from);
    if (!owner || !isClassLike(owner)) return undefined;
    const hits = this.index
      .inheritedMember(owner, from.name)
      .filter((n) => n.kind === 'method');
    const [target] = hits;
    if (hits.length !== 1 || !target) return undefined;
    return {
      source: from.id,
      target: target.id,
      kind: 'overrides',
      line: ref.line,
      provenance: 'static',
    };
  }

  private resolveName(name: string, from: NodeSummary): Resolution | undefined {
    const segs = name.split('.');
    const [head, ...rest] = segs;
    if (!head || segs.some((s) => s === '')) return undefined;
    let heuristic = false;
    let current: NodeSummary[];

    if (RECEIVER_WORDS[from.language]?.has(head)) {
      const cls = this.index.enclosingClass(from);
      if (!cls || rest.length === 0) return undefined;
      current = [cls];
    } else if (head === 'super' && SUPER_LANGUAGES.has(from.language)) {
      const cls = this.index.enclosingClass(from);
      const [first, ...after] = rest;
      if (!cls || first === undefined) return undefined;
      current = this.index.inheritedMember(cls, first);
      rest.splice(0, rest.length, ...after);
    } else {
      const receiver =
        from.language === 'go' ? this.goReceiver(from) : undefined;
      const binding = this.bindings.get(from.filePath)?.get(head);
      if (receiver && receiver.name === head) {
        current = [receiver.type];
      } else if (binding) {
        if (binding.kind === 'blocked') return undefined;
        if (binding.kind === 'symbol') {
          current = [binding.node];
        } else {
          const [first, ...after] = rest;
          if (first === undefined) return undefined;
          current = this.namespaceMember(binding.files, first);
          rest.splice(0, rest.length, ...after);
        }
      } else {
        current = this.index.scopeLookup(head, from);
        if (current.length === 0 && this.allowsProjectLookup(from)) {
          current = this.index.projectLookup(head, from);
          heuristic = true;
        }
      }
    }

    for (const seg of rest) {
      const [only] = current;
      if (current.length !== 1 || !only) return undefined;
      current = this.index.memberOf(only, seg);
    }
    const [target] = current;
    return current.length === 1 && target ? { target, heuristic } : undefined;
  }

  private namespaceMember(files: string[], name: string): NodeSummary[] {
    const hits = new Map<string, NodeSummary>();
    for (const file of files) {
      const hit = this.findExport(file, name, 0, new Set());
      if (hit?.kind === 'symbol') hits.set(hit.node.id, hit.node);
    }
    return [...hits.values()];
  }

  /** ES modules only see other files' names through imports; scripts share one global scope. */
  private allowsProjectLookup(from: NodeSummary): boolean {
    if (from.language !== 'typescript' && from.language !== 'javascript')
      return true;
    let isModule = this.esModules.get(from.filePath);
    if (isModule === undefined) {
      isModule = this.index
        .nodesInFile(from.filePath)
        .some(
          (n) => n.kind === 'import' || n.kind === 'export' || n.isExported,
        );
      this.esModules.set(from.filePath, isModule);
    }
    return !isModule;
  }

  /** The receiver variable and type of the Go method enclosing `from` (`func (s *S) Run()` → s, S). */
  private goReceiver(
    from: NodeSummary,
  ): { name: string; type: NodeSummary } | undefined {
    const method = this.index.ancestors(from).find((n) => n.kind === 'method');
    if (!method) return undefined;
    const cached = this.goReceivers.get(method.id);
    if (cached !== undefined) return cached ?? undefined;
    let result: { name: string; type: NodeSummary } | null = null;
    const match = /^func\s*\(\s*([A-Za-z_]\w*)\s+\*?\s*([A-Za-z_]\w*)/.exec(
      this.db.nodeById(method.id)?.signature ?? '',
    );
    const varName = match?.[1];
    const typeName = match?.[2];
    if (varName && typeName && varName !== '_') {
      const parent = this.index.parentOf(method);
      const type =
        parent && isClassLike(parent)
          ? parent
          : this.goTypeInPackage(method.filePath, typeName);
      if (type) result = { name: varName, type };
    }
    this.goReceivers.set(method.id, result);
    return result ?? undefined;
  }

  private goTypeInPackage(
    file: string,
    typeName: string,
  ): NodeSummary | undefined {
    const dir = path.posix.dirname(file);
    const hits = this.index
      .filesInDir(dir === '.' ? '' : dir)
      .flatMap((f) => this.index.nodesInFile(f))
      .filter(
        (n) =>
          n.name === typeName && isClassLike(n) && this.index.isTopLevel(n),
      );
    return hits.length === 1 ? hits[0] : undefined;
  }
}

/**
 * Final edge kind and target for a resolved name, or undefined when the target cannot be one.
 * `instantiates` of a constructor points at its class; of a function/method (Dart `Navigator.of`,
 * `BuildThing()`) it is really a call.
 */
function shapeEdge(
  kind: EdgeKind,
  target: NodeSummary,
  index: SymbolIndex,
): { kind: EdgeKind; target: NodeSummary } | undefined {
  if (NON_TARGETS.has(target.kind)) return undefined;
  switch (kind) {
    case 'instantiates': {
      if (isConstructor(target)) {
        const owner = index.parentOf(target);
        return owner && isClassLike(owner)
          ? { kind, target: owner }
          : undefined;
      }
      if (TYPE_TARGETS.has(target.kind)) return { kind, target };
      if (target.kind === 'function' || target.kind === 'method')
        return { kind: 'calls', target };
      return undefined;
    }
    case 'extends':
    case 'implements':
      return TYPE_TARGETS.has(target.kind) ? { kind, target } : undefined;
    case 'calls':
      return CALLABLE_TARGETS.has(target.kind) ? { kind, target } : undefined;
    default:
      return { kind, target };
  }
}

function isDroppedBuiltin(ref: UnresolvedRef): boolean {
  return (
    ref.language === 'go' &&
    !ref.referenceName.includes('.') &&
    GO_BUILTINS.has(ref.referenceName)
  );
}

const SOURCE_EXTENSION = /\.(d\.ts|[cm]?[jt]sx?|dart|pyi?|go|java)$/;

function fileStem(file: string): string {
  return path.posix.basename(file).replace(SOURCE_EXTENSION, '');
}

/**
 * Name tail stored on a failed import: the module's last segment (`./b` → b, `@app/util` → util,
 * `com.acme.Foo` → Foo), so a later file with that stem retries it.
 */
export function importStem(spec: string): string {
  const last = spec
    .slice(spec.lastIndexOf('/') + 1)
    .replace(SOURCE_EXTENSION, '');
  const dotted = last.slice(last.lastIndexOf('.') + 1);
  return dotted || last || spec;
}
