import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  EDGE_KINDS,
  type CodeGraphLanguage,
  type EdgeKind,
  type GraphEdge,
} from '../../../../../shared/domain/code-graph';
import type { GraphQueries, NodeSummary, UnresolvedRef } from '../db/queries';
import { REF_HEAD_TYPE, REF_OWNER_TYPE, UNKNOWN_TYPE } from '../extraction/type-facts';
import { inferGoImplements } from './go-implements';
import { resolverFor, type ResolveContext } from './language-resolvers';
import {
  collapseOverloads,
  isClassLike,
  isConstructor,
  SymbolIndex,
} from './name-matcher';
import {
  EMPTY_ENV,
  isValueNode,
  TypeInference,
  type Env,
} from './type-inference';

// Adapted from codegraph (MIT), src/resolution/index.ts, without frameworks or synthesizers.
//
// Phases run in order so later ones can lean on earlier edges: imports (file→file edges and
// per-file bindings) → extends/implements (supertypes for inherited members) → calls and the
// rest → overrides. Silence beats a wrong edge: anything ambiguous is marked `failed`.
//
// Receivers (S-44 T-515): `recv.m()` follows the receiver's declared or initializer type (facts
// recorded by the extractors, evaluated by TypeInference). A receiver whose type is unknown
// (an untyped parameter, `x = something()` with no declared return type) gets NO edge: codegraph
// falls back to "the only method with that name in the project" at confidence 0.7, but a
// unique-name guess is exactly the wrong edge this resolver refuses to emit, and impact analysis
// would then report callers that do not exist. Such refs stay `failed` and are retried when a
// file defining that name changes.

export interface ResolveStats {
  resolved: number;
  failed: number;
  /** Go interfaces not linked to their structs because too many structs satisfied them. */
  skippedImplements: number;
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
  /** Resolved imports that bind a name: kept as `bound` (see RefStatus). */
  bound: number[];
  deps: Map<string, Reads>;
}

/** What one ref's type inference read outside its own file. */
interface Reads {
  files: Set<string>;
  names: Set<string>;
}

interface ImportOutcome {
  targets: string[];
  binds: [string, Binding][];
  /** Name tail to store when the ref failed. */
  failTail?: string;
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
  private readonly types: TypeInference;
  /** Partial runs rebuild the import bindings of untouched files from their `bound` refs. */
  private partial = false;
  private readonly storedBindingsLoaded = new Set<string>();
  private reads: Reads | undefined;
  private readonly stats: ResolveStats = {
    resolved: 0,
    failed: 0,
    skippedImplements: 0,
  };

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
      readText: (rel) => {
        try {
          return fs.readFileSync(path.join(root, rel), 'utf8');
        } catch {
          return undefined;
        }
      },
    };
    this.index = new SymbolIndex(
      db.nodeSummaries(),
      db.edgesOfKinds(['contains', 'extends', 'implements', 'imports']),
      files,
    );
    this.types = new TypeInference({
      index: this.index,
      lookup: (name, from) => {
        const r = this.resolveName(name, from);
        return r && !r.heuristic ? [r.target] : [];
      },
      noteFile: (file) => this.reads?.files.add(file),
      noteName: (name) => this.reads?.names.add(name),
    });
  }

  run(onlyFiles: string[] | undefined): ResolveStats {
    this.partial = onlyFiles !== undefined;
    if (onlyFiles === undefined) {
      for (const kinds of PHASES)
        this.processAll(this.db.unresolvedByKinds('pending', kinds));
    } else {
      const refs = this.selectForFiles(onlyFiles);
      for (const kinds of PHASES)
        this.processAll(refs.filter((r) => kinds.includes(r.referenceKind)));
    }
    if (this.index.hasLanguage('go'))
      this.stats.skippedImplements += inferGoImplements(
        this.db,
      ).skippedInterfaces;
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
      const writes: BatchWrites = {
        edges: [],
        deletes: [],
        fails: [],
        bound: [],
        deps: new Map(),
      };
      for (const ref of refs.slice(start, start + BATCH_SIZE))
        this.processRef(ref, writes);
      this.db.transaction(() => {
        this.db.insertEdges(writes.edges);
        for (const id of writes.deletes) this.db.deleteUnresolved(id);
        for (const f of writes.fails)
          this.db.markUnresolved(f.id, 'failed', f.tail);
        for (const id of writes.bound) this.db.markUnresolved(id, 'bound');
        for (const [file, r] of writes.deps) {
          this.db.insertResolutionDeps(file, 'file', r.files);
          this.db.insertResolutionDeps(file, 'name', r.names);
        }
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
    this.reads = { files: new Set(), names: new Set() };
    let edge: GraphEdge | undefined;
    try {
      edge = this.resolveSymbolRef(ref, from);
    } finally {
      this.recordReads(ref.filePath, this.reads, writes);
      this.reads = undefined;
    }
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
    const outcome = this.importOutcome(ref);
    const sourceFile = this.index.fileNodes.get(ref.filePath);
    for (const t of outcome.targets) {
      const targetFile = this.index.fileNodes.get(t);
      if (t === ref.filePath || !targetFile || !sourceFile) continue;
      writes.edges.push({
        source: sourceFile.id,
        target: targetFile.id,
        kind: ref.referenceKind,
        provenance: 'static',
      });
      if (ref.referenceKind === 'imports')
        this.index.addImport(ref.filePath, t);
    }
    for (const [name, binding] of outcome.binds)
      this.bind(ref.filePath, name, binding);
    if (outcome.failTail !== undefined) {
      writes.fails.push({ id, tail: outcome.failTail });
      this.stats.failed++;
      return;
    }
    if (outcome.binds.length > 0) writes.bound.push(id);
    else writes.deletes.push(id);
    this.stats.resolved++;
  }

  /** Where an import lands and what it binds; no side effects, so stored refs can be replayed. */
  private importOutcome(ref: UnresolvedRef): ImportOutcome {
    const meta = ref.metadata ?? {};
    const bindingName =
      typeof meta['binding'] === 'string' ? meta['binding'] : undefined;
    const blocked: [string, Binding][] = bindingName
      ? [[bindingName, { kind: 'blocked' }]]
      : [];
    const resolver = resolverFor(ref.language);
    if (!resolver)
      return { targets: [], binds: [], failTail: importStem(ref.referenceName) };
    const star = meta['star'] === true;
    const imported =
      typeof meta['imported'] === 'string' ? meta['imported'] : undefined;
    const submodule =
      imported !== undefined && !star
        ? resolver.resolveSubmodule?.(
            ref.filePath,
            ref.referenceName,
            imported,
            this.ctx,
          )
        : undefined;
    let candidates: string[];
    if (submodule !== undefined) {
      // `from pkg import sub` runs pkg/__init__ before loading sub, so both are imported.
      const pkg = resolver.resolveImport(
        ref.filePath,
        ref.referenceName,
        this.ctx,
      );
      candidates =
        pkg !== undefined && pkg !== submodule && isPackageInit(pkg)
          ? [submodule, pkg]
          : [submodule];
    }
    else if (resolver.resolveImportAll)
      candidates = resolver.resolveImportAll(
        ref.filePath,
        ref.referenceName,
        this.ctx,
        star,
      );
    else {
      const one = resolver.resolveImport(
        ref.filePath,
        ref.referenceName,
        this.ctx,
      );
      candidates = one === undefined ? [] : [one];
    }
    const targets = candidates.filter((t) => this.index.fileNodes.has(t));
    const target = targets[0];
    if (target === undefined || !this.index.fileNodes.has(ref.filePath))
      return { targets: [], binds: blocked, failTail: importStem(ref.referenceName) };
    if (!bindingName) return { targets, binds: [] };
    let binding: Binding | undefined;
    if (
      star ||
      submodule !== undefined ||
      (imported === undefined && ref.language !== 'java')
    ) {
      binding = {
        kind: 'namespace',
        files: ref.language === 'go' ? targets : [target],
      };
    } else {
      binding = this.findExport(target, imported ?? bindingName, 0, new Set());
    }
    if (!binding)
      return { targets, binds: blocked, failTail: imported ?? bindingName };
    const dottedImport =
      ref.language === 'python' &&
      imported === undefined &&
      meta['alias'] === undefined &&
      ref.referenceName.includes('.');
    if (dottedImport) {
      // `import a.b` binds `a` to the package itself, never to the submodule `a/b.py`; the
      // dotted form is kept so `a.b.f()` still reaches `b.py`.
      const head = ref.referenceName.split('.')[0] ?? bindingName;
      const pkg = resolver.resolveImport(ref.filePath, head, this.ctx);
      return {
        targets,
        binds: [
          [
            bindingName,
            pkg !== undefined && this.index.fileNodes.has(pkg)
              ? { kind: 'namespace', files: [pkg] }
              : { kind: 'blocked' },
          ],
          [ref.referenceName, binding],
        ],
      };
    }
    return { targets, binds: [[bindingName, binding]] };
  }

  /**
   * A file's import bindings. A full run processes every import first; a partial run only the
   * touched files', so another file's are rebuilt from its stored `bound`/`failed` import refs
   * (in id order, like a full run), with this run's own results on top.
   */
  private bindingsOf(file: string): Map<string, Binding> | undefined {
    if (!this.partial || this.storedBindingsLoaded.has(file))
      return this.bindings.get(file);
    this.storedBindingsLoaded.add(file);
    const stored = [
      ...this.db.unresolvedInFiles([file], 'bound'),
      ...this.db.unresolvedInFiles([file], 'failed'),
    ]
      .filter((r) => IMPORT_KINDS.includes(r.referenceKind))
      .sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
    if (stored.length === 0) return this.bindings.get(file);
    const map = new Map<string, Binding>();
    for (const r of stored)
      for (const [name, binding] of this.importOutcome(r).binds)
        map.set(name, binding);
    for (const [name, binding] of this.bindings.get(file) ?? [])
      map.set(name, binding);
    this.bindings.set(file, map);
    return map;
  }

  private recordReads(file: string, reads: Reads, writes: BatchWrites): void {
    reads.files.delete(file);
    if (reads.files.size === 0 && reads.names.size === 0) return;
    let acc = writes.deps.get(file);
    if (!acc) writes.deps.set(file, (acc = { files: new Set(), names: new Set() }));
    for (const f of reads.files) acc.files.add(f);
    for (const n of reads.names) acc.names.add(n);
  }

  private bind(file: string, name: string, binding: Binding): void {
    let map = this.bindings.get(file);
    if (!map) this.bindings.set(file, (map = new Map()));
    map.set(name, binding);
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
        const resolver = resolverFor(e.language);
        const imported = e.metadata?.['imported'];
        const submodule =
          typeof imported === 'string'
            ? resolver?.resolveSubmodule?.(file, source, imported, this.ctx)
            : undefined;
        if (submodule !== undefined && this.index.fileNodes.has(submodule))
          return { kind: 'namespace', files: [submodule] };
        const next = resolver?.resolveImport(file, source, this.ctx);
        if (next === undefined) return undefined;
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
    if (file.endsWith('.java')) {
      // Nested types and static members: `import a.Outer.Inner`, `import static a.C.m`.
      const nested = collapseOverloads(
        nodes.filter(
          (n) =>
            n.name === name &&
            !NON_TARGETS.has(n.kind) &&
            !isConstructor(n) &&
            !this.index.isTopLevel(n) &&
            (isClassLike(n) || n.kind === 'method' || n.kind === 'field'),
        ),
      );
      const [only] = nested;
      if (nested.length === 1 && only) return { kind: 'symbol', node: only };
    }

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
    const resolution = this.resolveName(ref.referenceName, from, ref.metadata);
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

  private resolveName(
    name: string,
    from: NodeSummary,
    meta?: UnresolvedRef['metadata'],
  ): Resolution | undefined {
    const segs = name.split('.');
    const [head, ...rest] = segs;
    if (!head || segs.some((s) => s === '')) return undefined;
    let heuristic = false;
    let current: NodeSummary[];
    let env: Env = EMPTY_ENV;
    let inferred = false;

    const ownerType = meta?.[REF_OWNER_TYPE];
    const headType = meta?.[REF_HEAD_TYPE];
    if (typeof ownerType === 'string') {
      // A call on a computed receiver: the whole name is a member of the receiver's type.
      const owner = this.types.typeOf(ownerType, from);
      if (!owner) return undefined;
      current = [owner.node];
      env = owner.env;
      rest.unshift(head);
      inferred = true;
    } else if (typeof headType === 'string') {
      // The head is a local or parameter: its type decides, never an outer symbol of that name.
      if (headType === UNKNOWN_TYPE || rest.length === 0) return undefined;
      const recv = this.types.typeOf(headType, from);
      if (!recv) return undefined;
      current = [recv.node];
      env = recv.env;
      inferred = true;
    } else if (RECEIVER_WORDS[from.language]?.has(head)) {
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
      const fileBindings = this.bindingsOf(from.filePath);
      let binding = fileBindings?.get(head);
      if (from.language === 'python' && fileBindings) {
        for (let n = segs.length - 1; n >= 2; n--) {
          const dotted = fileBindings.get(segs.slice(0, n).join('.'));
          if (!dotted) continue;
          binding = dotted;
          rest.splice(0, n - 1);
          break;
        }
      }
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

    for (let i = 0; i < rest.length; i++) {
      const seg = rest[i] ?? '';
      const [only] = current;
      if (current.length !== 1 || !only) return undefined;
      let owner = only;
      let ownerEnv = env;
      let hits = this.index.memberOf(owner, seg);
      if (hits.length === 0 && isValueNode(owner)) {
        // `x.m()` on a field/variable: the members of its declared type.
        const t = this.types.valueType(owner, env);
        if (t) {
          owner = t.node;
          ownerEnv = t.env;
          hits = this.index.memberOf(owner, seg);
          inferred = true;
        }
      }
      if (inferred) this.reads?.names.add(seg);
      if (hits.length === 0 && i < rest.length - 1 && isClassLike(owner)) {
        // A field with no node of its own (TS parameter property, Python `self.x = …`).
        const t = this.types.fieldType({ node: owner, env: ownerEnv }, seg);
        if (t) {
          current = [t.node];
          env = t.env;
          inferred = true;
          continue;
        }
      }
      const [hit] = hits;
      env =
        hits.length === 1 && hit
          ? this.types.memberEnv({ node: owner, env: ownerEnv }, hit)
          : EMPTY_ENV;
      current = hits;
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

function isPackageInit(file: string): boolean {
  return /(^|\/)__init__\.pyi?$/.test(file);
}

const SOURCE_EXTENSION =/\.(d\.ts|[cm]?[jt]sx?|dart|pyi?|go|java)$/;

export function fileStem(file: string): string {
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
