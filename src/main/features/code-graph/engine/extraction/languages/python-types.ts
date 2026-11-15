import type { Node } from 'web-tree-sitter';
import type { RefMetadata } from '../../../../../../shared/domain/code-graph';
import { nodeText } from '../extractor';
import { ScopeStack } from '../local-scopes';
import { extendChain, REF_HEAD_TYPE, REF_OWNER_TYPE, typeExpr, UNKNOWN_TYPE } from '../type-facts';

// Receiver type facts for Python (S-44 T-515), in the shared TypeExpr form of type-facts.ts.
//
// A Python local belongs to the whole function, wherever it is assigned, so each function is
// pre-scanned on entry: every name it binds (assignment, for/with/except targets, walrus) gets
// ONE fact for the whole body: the annotation if any, else the common fact of all its
// assignments. Two assignments that disagree, or one we cannot type, leave the name a typed-
// unknown local (silence); `x = None` adds no information. `self.x = …` in methods types the
// field `x` of the class the same way (all methods together), and an unannotated function whose
// every `return` yields the same fact returns that (`return Router(…)`, `return self`).
// Untyped parameters stay unknown: no guessing by method name.

const OWN_SCOPE_STOP: ReadonlySet<string> = new Set([
  'function_definition',
  'class_definition',
  'lambda',
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
]);

const COMPREHENSIONS: ReadonlySet<string> = new Set([
  'list_comprehension',
  'set_comprehension',
  'dictionary_comprehension',
  'generator_expression',
]);

const NO_INFO = Symbol('none');
type Fact = string | undefined | typeof NO_INFO;

/** Facts a function contributes beyond its locals. */
export interface FunctionFacts {
  returns: string | undefined;
  /** `self.<name>` assignments: fact, or undefined when one of them cannot be typed. */
  selfFields: Map<string, string | undefined>;
}

interface Binding {
  /** Annotation: wins over every assignment. */
  declared?: string;
  values: Node[];
  unknown: boolean;
}

export class PythonLocals extends ScopeStack {
  constructor(private readonly source: string) {
    super();
  }

  /** Lambdas and comprehensions: their own (untyped) names. Functions go through enterFunction. */
  declareBindings(node: Node): void {
    if (node.type === 'lambda') {
      for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
        const name = paramName(p);
        if (name) this.declare(nodeText(this.source, name), undefined, node);
      }
    } else if (COMPREHENSIONS.has(node.type)) {
      for (const clause of node.namedChildren) {
        if (clause?.type !== 'for_in_clause') continue;
        for (const id of identifiers(clause.childForFieldName('left'))) this.declare(nodeText(this.source, id), undefined, node);
      }
    }
  }

  /**
   * Declares the parameters and locals of a function for its whole body and returns its return
   * and `self` field facts. `selfName`: the first parameter of a method (never a local).
   */
  enterFunction(fn: Node, selfName: string | undefined, isAsync: boolean): FunctionFacts {
    const bindings = new Map<string, Binding>();
    const binding = (name: string): Binding => {
      let b = bindings.get(name);
      if (!b) bindings.set(name, (b = { values: [], unknown: false }));
      return b;
    };
    const excluded = new Set<string>();
    if (selfName) excluded.add(selfName);
    for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
      const name = p ? paramName(p) : undefined;
      if (!p || !name) continue;
      const text = nodeText(this.source, name);
      if (text === selfName) continue;
      const declared = p.type === 'typed_parameter' || p.type === 'typed_default_parameter' ? typeFact(p.childForFieldName('type'), this.source) : undefined;
      const b = binding(text);
      if (declared) b.declared = declared;
      else b.unknown = true;
    }

    const selfAssignments = new Map<string, Node[]>();
    const selfDeclared = new Map<string, string>();
    const selfUnknown = new Set<string>();
    const returns: (Node | null)[] = [];
    let generator = false;
    const body = fn.childForFieldName('body');
    /** Records what `n` binds; false skips its children. */
    const visit = (n: Node): boolean => {
      switch (n.type) {
        case 'assignment':
          this.collectAssignment(n, binding, selfName, { values: selfAssignments, declared: selfDeclared, unknown: selfUnknown });
          break;
        case 'augmented_assignment': {
          const left = n.childForFieldName('left');
          if (left?.type === 'identifier') binding(nodeText(this.source, left)).unknown = true;
          break;
        }
        case 'for_statement':
          for (const id of identifiers(n.childForFieldName('left'))) binding(nodeText(this.source, id)).unknown = true;
          break;
        case 'as_pattern': {
          const target = n.childForFieldName('alias');
          const ids = identifiers(target);
          const isExcept = n.parent?.type === 'except_clause';
          const caught = isExcept ? typeFact(n.namedChildren[0], this.source) : undefined;
          for (const id of ids) {
            const b = binding(nodeText(this.source, id));
            if (caught && ids.length === 1) b.declared = caught;
            else b.unknown = true;
          }
          break;
        }
        case 'named_expression': {
          const name = n.childForFieldName('name');
          const value = n.childForFieldName('value');
          if (name && value) binding(nodeText(this.source, name)).values.push(value);
          break;
        }
        case 'global_statement':
        case 'nonlocal_statement':
          for (const id of n.namedChildren) if (id?.type === 'identifier') excluded.add(nodeText(this.source, id));
          break;
        case 'import_statement':
        case 'import_from_statement':
          // Imported names are file bindings in this model: never shadow them with a local.
          for (const id of importedNames(n, this.source)) excluded.add(id);
          return false;
        case 'return_statement':
          returns.push(n.namedChildren[0] ?? null);
          break;
        case 'yield':
          generator = true;
          break;
        default:
          break;
      }
      return true;
    };
    // Iterative, in document order: deep expression trees must not blow the stack.
    const pending: Node[] = body ? [body] : [];
    for (let n = pending.pop(); n; n = pending.pop()) {
      if (!visit(n)) continue;
      const children = n.namedChildren;
      for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        if (c && !OWN_SCOPE_STOP.has(c.type) && c.type !== 'decorated_definition') pending.push(c);
      }
    }

    // Facts of locals may refer to other locals: resolve lazily, guarding cycles.
    const resolved = new Map<string, string | undefined>();
    const inProgress = new Set<string>();
    const localFact: LocalLookup = (name, at) => {
      if (excluded.has(name)) return undefined;
      const b = bindings.get(name);
      // Not bound here: an enclosing function's local (a closure) or a global.
      if (!b) return this.find(name, at);
      if (resolved.has(name)) return { fact: resolved.get(name) };
      if (inProgress.has(name)) return { fact: undefined };
      inProgress.add(name);
      let fact: string | undefined;
      if (b.declared !== undefined) fact = b.declared;
      else if (!b.unknown) fact = merge(b.values.map((v) => valueFact(v)));
      inProgress.delete(name);
      resolved.set(name, fact);
      return { fact };
    };
    const valueFact = (value: Node | null): Fact =>
      !value ? undefined : value.type === 'none' ? NO_INFO : this.exprFact(value, localFact);
    for (const name of bindings.keys()) {
      if (excluded.has(name)) continue;
      const local = localFact(name, fn);
      this.declare(name, local?.fact, fn);
    }

    const selfFields = new Map<string, string | undefined>();
    for (const name of new Set([...selfAssignments.keys(), ...selfDeclared.keys(), ...selfUnknown])) {
      const declared = selfDeclared.get(name);
      selfFields.set(
        name,
        declared ?? (selfUnknown.has(name) ? undefined : merge((selfAssignments.get(name) ?? []).map((v) => valueFact(v)))),
      );
    }

    let returnFact: string | undefined;
    if (!generator && !isAsync && returns.length > 0 && returns.every((r) => r !== null)) {
      returnFact = merge(returns.map((r) => valueFact(r)));
    }
    return { returns: returnFact, selfFields };
  }

  private collectAssignment(
    n: Node,
    binding: (name: string) => Binding,
    selfName: string | undefined,
    self: { values: Map<string, Node[]>; declared: Map<string, string>; unknown: Set<string> },
  ): void {
    const left = n.childForFieldName('left');
    // `a = b = Foo()`: the walk visits the inner assignment for `b` on its own.
    let right = n.childForFieldName('right');
    while (right?.type === 'assignment') right = right.childForFieldName('right');
    const declared = typeFact(n.childForFieldName('type'), this.source);
    if (left?.type === 'identifier') {
      const b = binding(nodeText(this.source, left));
      if (declared) b.declared = declared;
      else if (right) b.values.push(right);
      else b.unknown = true;
    } else if (left?.type === 'attribute' && selfName) {
      const object = left.childForFieldName('object');
      const attr = left.childForFieldName('attribute');
      if (object?.type === 'identifier' && nodeText(this.source, object) === selfName && attr) {
        const name = nodeText(this.source, attr);
        if (declared) self.declared.set(name, declared);
        else if (right) self.values.set(name, [...(self.values.get(name) ?? []), right]);
        else self.unknown.add(name);
      }
    } else {
      for (const id of identifiers(left)) binding(nodeText(this.source, id)).unknown = true;
    }
  }

  /** The TypeExpr of an expression used as a receiver; undefined when nothing can be said. */
  exprFact(expr: Node | null | undefined, localFact: LocalLookup = (name, at) => this.find(name, at)): string | undefined {
    if (!expr) return undefined;
    switch (expr.type) {
      case 'identifier': {
        const name = nodeText(this.source, expr);
        const local = localFact(name, expr);
        return local ? local.fact : `=${name}`;
      }
      case 'parenthesized_expression':
        return this.exprFact(expr.namedChildren[0], localFact);
      case 'attribute': {
        const base = this.exprFact(expr.childForFieldName('object'), localFact);
        const attr = expr.childForFieldName('attribute');
        return base && attr ? extendChain(base, nodeText(this.source, attr), false) : undefined;
      }
      case 'call': {
        const fn = expr.childForFieldName('function');
        if (fn?.type === 'identifier') {
          const name = nodeText(this.source, fn);
          return localFact(name, fn) || name === 'super' ? undefined : `=${name}()`;
        }
        if (fn?.type !== 'attribute') return undefined;
        const base = this.exprFact(fn.childForFieldName('object'), localFact);
        const attr = fn.childForFieldName('attribute');
        return base && attr ? extendChain(base, nodeText(this.source, attr), true) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Metadata for a call whose callee is `callee`: `headType` when the callee name starts at a
   * local or parameter, `ownerType` when the receiver is computed (the ref name is then the bare
   * attribute; see `computedReceiver`).
   */
  callMetadata(callee: Node): RefMetadata | undefined {
    if (callee.type === 'identifier') {
      return this.find(nodeText(this.source, callee), callee) ? { [REF_HEAD_TYPE]: UNKNOWN_TYPE } : undefined;
    }
    if (callee.type !== 'attribute') return undefined;
    const base = chainBase(callee);
    if (base.type !== 'identifier') {
      return { [REF_OWNER_TYPE]: this.exprFact(callee.childForFieldName('object')) ?? UNKNOWN_TYPE };
    }
    const local = this.find(nodeText(this.source, base), base);
    return local ? { [REF_HEAD_TYPE]: local.fact ?? UNKNOWN_TYPE } : undefined;
  }
}

type LocalLookup = (name: string, at: Node) => { fact: string | undefined } | undefined;

/** The innermost object of an attribute chain (`a.b.c` → `a`, `f().b` → `f()`). */
export function chainBase(node: Node): Node {
  let base = node;
  while (base.type === 'attribute') {
    const object = base.childForFieldName('object');
    if (!object) return base;
    base = object;
  }
  return base;
}

function merge(facts: Fact[]): string | undefined {
  let only: string | undefined;
  for (const f of facts) {
    if (f === NO_INFO) continue;
    if (f === undefined) return undefined;
    if (only !== undefined && only !== f) return undefined;
    only = f;
  }
  return only;
}

function paramName(p: Node | null): Node | undefined {
  if (!p) return undefined;
  if (p.type === 'identifier') return p;
  if (p.type === 'typed_default_parameter' || p.type === 'default_parameter') return p.childForFieldName('name') ?? undefined;
  if (p.type === 'typed_parameter' || p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') {
    const id = p.namedChildren.find((c) => c?.type === 'identifier');
    return id ?? undefined;
  }
  return undefined;
}

function identifiers(node: Node | null | undefined): Node[] {
  if (!node) return [];
  if (node.type === 'identifier') return [node];
  if (node.type === 'attribute' || node.type === 'subscript') return [];
  return node.namedChildren.flatMap((c) => identifiers(c));
}

function importedNames(n: Node, source: string): string[] {
  return n.childrenForFieldName('name').flatMap((part) => {
    if (!part) return [];
    const alias = part.type === 'aliased_import' ? part.childForFieldName('alias') : null;
    if (alias) return [nodeText(source, alias)];
    const text = nodeText(source, part.type === 'aliased_import' ? (part.childForFieldName('name') ?? part) : part);
    return [n.type === 'import_statement' ? (text.split('.')[0] ?? text) : text];
  });
}

const OPTIONAL_WRAPPERS: ReadonlySet<string> = new Set(['Optional', 'typing.Optional', 'Annotated', 'typing.Annotated', 'Final', 'typing.Final', 'ClassVar', 'typing.ClassVar']);

/** A type annotation as a TypeExpr: `Foo`, `m.Foo`, `"Foo"`, `Optional[Foo]`, `Foo | None`, `Repo[User]`. */
export function typeFact(node: Node | null | undefined, source: string): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'type':
      return typeFact(node.namedChildren[0], source);
    case 'identifier':
      return nodeText(source, node);
    case 'attribute': {
      const text = nodeText(source, node).replace(/\s+/g, '');
      return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(text) ? text : undefined;
    }
    case 'string': {
      const content = node.namedChildren.find((c) => c?.type === 'string_content');
      const text = content ? nodeText(source, content).trim() : '';
      return /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(text) ? text : undefined;
    }
    case 'binary_operator': {
      const sides = [node.childForFieldName('left'), node.childForFieldName('right')].filter((s) => s && s.type !== 'none');
      return sides.length === 1 ? typeFact(sides[0], source) : undefined;
    }
    case 'generic_type':
    case 'subscript': {
      const head = node.type === 'subscript' ? node.childForFieldName('value') : node.namedChildren[0];
      const name = typeFact(head, source);
      if (!name) return undefined;
      const args =
        node.type === 'subscript'
          ? node.childrenForFieldName('subscript')
          : (node.namedChildren.find((c) => c?.type === 'type_parameter')?.namedChildren ?? []);
      const real = args.filter((a) => a && a.type !== 'none');
      if (OPTIONAL_WRAPPERS.has(name)) return typeFact(real[0], source);
      if (name === 'Union' || name === 'typing.Union') return real.length === 1 ? typeFact(real[0], source) : undefined;
      return typeExpr(name, real.map((a) => typeFact(a, source)));
    }
    default:
      return undefined;
  }
}

/** `class C(Generic[T, K])` / `Protocol[T]`: the generic parameter names. */
export function genericParams(classNode: Node, source: string): string | undefined {
  const supers = classNode.childForFieldName('superclasses');
  for (const arg of supers?.namedChildren ?? []) {
    if (arg?.type !== 'subscript') continue;
    const head = arg.childForFieldName('value');
    const name = head ? nodeText(source, head) : '';
    if (!/^(typing\.)?(Generic|Protocol)$/.test(name)) continue;
    const names = arg.childrenForFieldName('subscript').flatMap((s) => (s?.type === 'identifier' ? [nodeText(source, s)] : []));
    if (names.length > 0) return names.join(',');
  }
  return undefined;
}
