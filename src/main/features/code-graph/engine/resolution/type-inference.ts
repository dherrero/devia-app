import type { NodeSummary } from '../db/queries';
import {
  BOUND_FACT_PREFIX,
  FACT_RETURNS,
  FACT_TYPE,
  FACT_TYPE_PARAMS,
  FIELD_FACT_PREFIX,
  isChain,
  parseChain,
  parseType,
  UNKNOWN_TYPE,
} from '../extraction/type-facts';
import { byNamespace, isClassLike, type SymbolIndex } from './name-matcher';

// Receiver type inference (S-44 T-515), language-neutral: evaluates the TypeExpr facts that
// extractors leave on nodes and refs (see extraction/type-facts.ts) down to a class-like node
// plus its generic arguments. Languages only differ in what their extractor records; adding a
// language means emitting the same facts, not touching this file.
//
// Silence beats a wrong edge: every step needs exactly one candidate, generics only bind
// through the receiver's own declared arguments (`Repo<Order>` → `T` = Order in Repo's own
// members; an inherited member sees no bindings), and an unknown type stops the chain.

export type Env = ReadonlyMap<string, TypeRef>;

export interface TypeRef {
  node: NodeSummary;
  /** Generic arguments of `node` (its type parameter name → bound type). */
  env: Env;
}

export interface InferenceHost {
  readonly index: SymbolIndex;
  /**
   * Candidates for a (possibly dotted) name as written in `from`'s file: bindings, scope, project.
   * `call`: whether the name is called (`f()`) or used as a value/type, when that matters.
   */
  lookup(name: string, from: NodeSummary, call?: boolean): NodeSummary[];
  /** Records what a resolution read, so a sync can re-resolve it when that changes. */
  noteFile(file: string): void;
  noteName(name: string): void;
}

export const EMPTY_ENV: Env = new Map();
const MAX_DEPTH = 12;
const VALUE_KINDS: ReadonlySet<string> = new Set(['property', 'field', 'variable', 'constant']);
const CALLABLE_KINDS: ReadonlySet<string> = new Set(['function', 'method', 'component']);

export function isValueNode(n: NodeSummary): boolean {
  return VALUE_KINDS.has(n.kind);
}

function fact(n: NodeSummary, key: string): string | undefined {
  const v = n.metadata?.[key];
  return typeof v === 'string' && v !== '' && v !== UNKNOWN_TYPE ? v : undefined;
}

function typeParams(n: NodeSummary): string[] {
  const v = fact(n, FACT_TYPE_PARAMS);
  return v ? v.split(',') : [];
}

interface Reads {
  files: Set<string>;
  names: Set<string>;
}

interface Cached {
  result: TypeRef | undefined;
  reads: Reads;
}

export class TypeInference {
  private readonly cache = new Map<string, Cached>();
  /** What the evaluations in progress read; a cached result replays its reads to its new reader. */
  private readonly frames: Reads[] = [];

  constructor(private readonly host: InferenceHost) {}

  private noteFile(file: string): void {
    const top = this.frames[this.frames.length - 1];
    if (top) top.files.add(file);
    else this.host.noteFile(file);
  }

  private noteName(name: string): void {
    const top = this.frames[this.frames.length - 1];
    if (top) top.names.add(name);
    else this.host.noteName(name);
  }

  private replay(reads: Reads): void {
    for (const f of reads.files) this.noteFile(f);
    for (const n of reads.names) this.noteName(n);
  }

  /** Evaluates a fact as seen from `ctx` (the node that holds it, or the ref's source). */
  typeOf(expr: string, ctx: NodeSummary, env: Env = EMPTY_ENV): TypeRef | undefined {
    const key = `${ctx.id}\0${expr}\0${envKey(env)}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.replay(cached.reads);
      return cached.result;
    }
    if (this.frames.length >= MAX_DEPTH) return undefined;
    const reads: Reads = { files: new Set([ctx.filePath]), names: new Set() };
    // Registered before evaluating, so a fact that refers to itself resolves to nothing.
    this.cache.set(key, { result: undefined, reads });
    this.frames.push(reads);
    let result: TypeRef | undefined;
    try {
      result = isChain(expr) ? this.chainType(expr, ctx, env) : this.namedType(expr, ctx, env);
    } finally {
      this.frames.pop();
    }
    if (result) reads.files.add(result.node.filePath);
    this.cache.set(key, { result, reads });
    this.replay(reads);
    return result;
  }

  /** The declared type of a value node (field, property, variable), in its owner's bindings. */
  valueType(node: NodeSummary, env: Env): TypeRef | undefined {
    const expr = fact(node, FACT_TYPE);
    return expr === undefined ? undefined : this.typeOf(expr, node, env);
  }

  /** The declared return type of a function or method. */
  returnType(node: NodeSummary, env: Env): TypeRef | undefined {
    const expr = fact(node, FACT_RETURNS);
    return expr === undefined ? undefined : this.typeOf(expr, node, env);
  }

  /** A field without a node of its own (`ft:<name>` on the class or a supertype). */
  fieldType(owner: TypeRef, name: string): TypeRef | undefined {
    const key = `${FIELD_FACT_PREFIX}${name}`;
    const seen = new Set<string>();
    let level: TypeRef[] = [owner];
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0; depth++) {
      const next: TypeRef[] = [];
      for (const t of level) {
        if (seen.has(t.node.id)) continue;
        seen.add(t.node.id);
        this.noteFile(t.node.filePath);
        const expr = fact(t.node, key);
        if (expr !== undefined) return this.typeOf(expr, t.node, t.env);
        for (const s of this.host.index.supertypesOf(t.node)) next.push({ node: s, env: EMPTY_ENV });
      }
      level = next;
    }
    return undefined;
  }

  /**
   * One member step from `owner`: `.name` (a field's type, a nested type) or `.name()` (the
   * member's declared return type). Undefined unless exactly one member answers.
   */
  step(owner: TypeRef, name: string, call: boolean): TypeRef | undefined {
    this.noteName(name);
    const hits = byNamespace(this.host.index.memberOf(owner.node, name), call);
    if (hits.length > 1) return undefined;
    const [hit] = hits;
    if (!hit) return call ? undefined : this.fieldType(owner, name);
    const env = this.memberEnv(owner, hit);
    if (call) {
      return CALLABLE_KINDS.has(hit.kind) ? this.returnType(hit, env) : undefined;
    }
    if (isValueNode(hit)) return this.valueType(hit, env);
    if (isClassLike(hit)) return { node: hit, env: EMPTY_ENV };
    return undefined;
  }

  /** Bindings a member of `owner` sees: the owner's own arguments, none for an inherited member. */
  memberEnv(owner: TypeRef, member: NodeSummary): Env {
    return this.host.index.parentOf(member)?.id === owner.node.id ? owner.env : EMPTY_ENV;
  }

  /** What a value or callable node evaluates to when used as a receiver (`x.m()`, `f().m()`). */
  asReceiver(node: NodeSummary, env: Env, call: boolean): TypeRef | undefined {
    if (call) {
      if (CALLABLE_KINDS.has(node.kind)) return this.returnType(node, env);
      // Calling a class constructs an instance (Python, Dart, Kotlin-style constructors).
      if (isClassLike(node)) return { node, env: EMPTY_ENV };
      return undefined;
    }
    if (isValueNode(node)) return this.valueType(node, env);
    if (isClassLike(node)) return { node, env: EMPTY_ENV };
    return undefined;
  }

  private chainType(expr: string, ctx: NodeSummary, env: Env): TypeRef | undefined {
    const chain = parseChain(expr);
    if (!chain) return undefined;
    let current: TypeRef | undefined;
    const { head } = chain;
    if (head.type !== undefined) {
      current = this.typeOf(head.type, ctx, env);
      if (current && head.call) current = undefined;
    } else if (head.name === 'this' || head.name === 'self') {
      const cls = this.host.index.enclosingClass(ctx);
      current = cls && !head.call ? { node: cls, env: cls.id === ctx.id ? env : this.enclosingEnv(ctx, cls, env) } : undefined;
    } else {
      this.noteName(head.name);
      const hits = this.host.lookup(head.name, ctx, head.call);
      const [only] = hits;
      if (hits.length === 1 && only) {
        this.noteFile(only.filePath);
        current = this.asReceiver(only, EMPTY_ENV, head.call);
      }
    }
    for (const seg of chain.segs) {
      if (!current) return undefined;
      current = this.step(current, seg.name, seg.call);
    }
    return current;
  }

  /** `env` is the holder's; it applies to the enclosing class only when the holder is its member. */
  private enclosingEnv(ctx: NodeSummary, cls: NodeSummary, env: Env): Env {
    return this.host.index.parentOf(ctx)?.id === cls.id ? env : EMPTY_ENV;
  }

  private namedType(expr: string, ctx: NodeSummary, env: Env): TypeRef | undefined {
    const parsed = parseType(expr);
    if (!parsed) return undefined;
    const bound = env.get(parsed.name);
    if (bound) return bound;
    if (!parsed.name.includes('.')) {
      const declarer = this.host.index.ancestors(ctx).find((n) => typeParams(n).includes(parsed.name));
      if (declarer) {
        // Unbound here: only its declared upper bound, if any, is known about it.
        const upper = fact(declarer, `${BOUND_FACT_PREFIX}${parsed.name}`);
        return upper === undefined ? undefined : this.typeOf(upper, declarer, EMPTY_ENV);
      }
    }
    this.noteName(lastSegment(parsed.name));
    const hits = this.host.lookup(parsed.name, ctx, false).filter(isClassLike);
    const [node] = hits;
    if (hits.length !== 1 || !node) return undefined;
    this.noteFile(node.filePath);
    const params = typeParams(node);
    if (params.length === 0 || parsed.args.length === 0) return { node, env: EMPTY_ENV };
    const bindings = new Map<string, TypeRef>();
    params.forEach((p, i) => {
      const arg = parsed.args[i];
      const t = arg === undefined ? undefined : this.typeOf(arg, ctx, env);
      if (t) bindings.set(p, t);
    });
    return { node, env: bindings };
  }

}

function lastSegment(name: string): string {
  return name.slice(name.lastIndexOf('.') + 1);
}

function envKey(env: Env): string {
  if (env.size === 0) return '';
  return [...env].map(([k, v]) => `${k}=${v.node.id}[${envKey(v.env)}]`).join(',');
}
