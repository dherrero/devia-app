import type { Node } from 'web-tree-sitter';
import type { RefMetadata } from '../../../../../../shared/domain/code-graph';
import { nodeText } from '../extractor';
import { ScopeStack } from '../local-scopes';
import {
  BOUND_FACT_PREFIX,
  extendChain,
  FACT_TYPE_PARAMS,
  REF_HEAD_TYPE,
  REF_OWNER_TYPE,
  typeExpr,
  UNKNOWN_TYPE,
} from '../type-facts';

// Receiver type facts for Go (S-44 T-515), in the shared TypeExpr form of type-facts.ts.
// Pointers are transparent (`*T` has T's methods). Parameters, named results, `:=` and `var`
// locals, type-switch aliases and closure parameters are tracked per lexical scope; a call
// returning several values types only the first variable it binds (`item, err := s.Get()`).
// The method receiver is not a local: the resolver reads it from the method signature.

const BUILTIN_TYPES: ReadonlySet<string> = new Set(
  (
    'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string ' +
    'uint uint8 uint16 uint32 uint64 uintptr any comparable'
  ).split(' '),
);

const FUNCTIONS: ReadonlySet<string> = new Set(['function_declaration', 'method_declaration', 'func_literal']);

export class GoLocals extends ScopeStack {
  constructor(private readonly source: string) {
    super();
  }

  /** Names a node brings into scope before its children are walked. */
  declareBindings(node: Node): void {
    if (FUNCTIONS.has(node.type)) {
      this.declareParams(node.childForFieldName('parameters'), node);
      const result = node.childForFieldName('result');
      if (result?.type === 'parameter_list') this.declareParams(result, node);
      return;
    }
    switch (node.type) {
      case 'short_var_declaration': {
        const scope = node.parent?.type === 'for_clause' ? node.parent.parent : node.parent;
        const left = node.childForFieldName('left')?.namedChildren ?? [];
        const right = node.childForFieldName('right')?.namedChildren ?? [];
        if (scope) this.declareAssigned(left, right, undefined, scope, node.startIndex);
        return;
      }
      case 'var_declaration': {
        const scope = node.parent;
        if (!scope || scope.type === 'source_file') return;
        const specs = node.namedChildren.flatMap((c) => (c?.type === 'var_spec_list' ? c.namedChildren : [c]));
        for (const spec of specs) {
          if (spec?.type !== 'var_spec') continue;
          const names = spec.childrenForFieldName('name').filter((n): n is Node => n?.type === 'identifier');
          const values = spec.childForFieldName('value')?.namedChildren ?? [];
          this.declareAssigned(names, values, typeFact(spec.childForFieldName('type'), this.source), scope, node.startIndex);
        }
        return;
      }
      case 'range_clause': {
        const loop = node.parent;
        for (const n of node.childForFieldName('left')?.namedChildren ?? [])
          if (n?.type === 'identifier' && loop) this.declare(nodeText(this.source, n), undefined, loop, node.startIndex);
        return;
      }
      case 'type_switch_statement': {
        const alias = node.childForFieldName('alias')?.namedChildren[0];
        if (alias?.type !== 'identifier') return;
        const name = nodeText(this.source, alias);
        // Last clause first: the stack keeps the innermost (earliest ending) scope on top.
        for (const clause of [...node.namedChildren].reverse()) {
          if (clause?.type !== 'type_case' && clause?.type !== 'default_case') continue;
          const types = clause.type === 'type_case' ? clause.childrenForFieldName('type') : [];
          this.declare(name, types.length === 1 ? typeFact(types[0], this.source) : undefined, clause);
        }
        return;
      }
      default:
        return;
    }
  }

  private declareParams(list: Node | null, scope: Node): void {
    for (const p of list?.namedChildren ?? []) {
      if (p?.type !== 'parameter_declaration' && p?.type !== 'variadic_parameter_declaration') continue;
      const fact = p.type === 'parameter_declaration' ? typeFact(p.childForFieldName('type'), this.source) : undefined;
      for (const n of p.childrenForFieldName('name'))
        if (n?.type === 'identifier') this.declare(nodeText(this.source, n), fact, scope);
    }
  }

  /** `a, b := x, y` types each name by its value; `a, err := f()` only the first, by f's result. */
  private declareAssigned(names: (Node | null)[], values: (Node | null)[], declared: string | undefined, scope: Node, from: number): void {
    const facts = names.map((_, i) => {
      if (declared !== undefined) return declared;
      if (values.length === names.length) return this.exprFact(values[i]);
      return i === 0 && values.length === 1 ? this.exprFact(values[0]) : undefined;
    });
    names.forEach((n, i) => {
      if (n?.type !== 'identifier') return;
      const name = nodeText(this.source, n);
      if (name !== '_') this.declare(name, facts[i], scope, from);
    });
  }

  /** The TypeExpr of an expression used as a receiver; undefined when nothing can be said. */
  exprFact(expr: Node | null | undefined): string | undefined {
    if (!expr) return undefined;
    switch (expr.type) {
      case 'composite_literal':
        return typeFact(expr.childForFieldName('type'), this.source);
      case 'unary_expression': {
        const op = expr.childForFieldName('operator');
        const text = op ? nodeText(this.source, op) : '';
        return text === '&' || text === '*' ? this.exprFact(expr.childForFieldName('operand')) : undefined;
      }
      case 'parenthesized_expression':
        return this.exprFact(expr.namedChildren[0]);
      case 'type_assertion_expression':
        return typeFact(expr.childForFieldName('type'), this.source);
      case 'identifier': {
        const name = nodeText(this.source, expr);
        const local = this.find(name, expr);
        if (local) return local.fact;
        return name === 'nil' || name === 'true' || name === 'false' ? undefined : `=${name}`;
      }
      case 'selector_expression': {
        const base = this.exprFact(expr.childForFieldName('operand'));
        const field = expr.childForFieldName('field');
        return base && field ? extendChain(base, nodeText(this.source, field), false) : undefined;
      }
      case 'call_expression': {
        const fn = expr.childForFieldName('function');
        if (fn?.type === 'identifier') {
          const name = nodeText(this.source, fn);
          return this.find(name, fn) ? undefined : `=${name}()`;
        }
        if (fn?.type !== 'selector_expression') return undefined;
        const base = this.exprFact(fn.childForFieldName('operand'));
        const field = fn.childForFieldName('field');
        return base && field ? extendChain(base, nodeText(this.source, field), true) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Metadata for a call whose callee is `fn`: `headType` when the callee name starts at a local
   * or parameter, `ownerType` when the receiver is computed (`f().M()`, `x.(T).M()`).
   * `named` says whether the extractor kept a dotted receiver in the ref name.
   */
  callMetadata(fn: Node, named: boolean): RefMetadata | undefined {
    if (fn.type === 'identifier') {
      return this.find(nodeText(this.source, fn), fn) ? { [REF_HEAD_TYPE]: UNKNOWN_TYPE } : undefined;
    }
    if (fn.type !== 'selector_expression') return undefined;
    const operand = fn.childForFieldName('operand');
    if (!operand) return undefined;
    if (!named) return { [REF_OWNER_TYPE]: this.exprFact(operand) ?? UNKNOWN_TYPE };
    let base = operand;
    while (base.type === 'selector_expression') {
      const inner = base.childForFieldName('operand');
      if (!inner) return undefined;
      base = inner;
    }
    if (base.type !== 'identifier') return undefined;
    const local = this.find(nodeText(this.source, base), base);
    return local ? { [REF_HEAD_TYPE]: local.fact ?? UNKNOWN_TYPE } : undefined;
  }
}

/** A Go type as a TypeExpr: named types (pointers transparent) with their type arguments. */
export function typeFact(node: Node | null | undefined, source: string): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'type_identifier': {
      const text = nodeText(source, node);
      return BUILTIN_TYPES.has(text) ? undefined : text;
    }
    case 'qualified_type':
      return nodeText(source, node).replace(/\s+/g, '');
    case 'pointer_type':
    case 'parenthesized_type':
    case 'type_elem':
    case 'type_constraint':
      return node.namedChildren.length === 1 ? typeFact(node.namedChildren[0], source) : undefined;
    case 'generic_type': {
      const name = typeFact(node.childForFieldName('type'), source);
      const args = node.childForFieldName('type_arguments');
      return name ? typeExpr(name, (args?.namedChildren ?? []).map((a) => typeFact(a, source))) : undefined;
    }
    default:
      return undefined;
  }
}

/** First result type of a function or method (`(T, error)` → T). */
export function returnFact(node: Node, source: string): string | undefined {
  const result = node.childForFieldName('result');
  if (!result) return undefined;
  if (result.type !== 'parameter_list') return typeFact(result, source);
  const first = result.namedChildren.find((c) => c?.type === 'parameter_declaration');
  return first ? typeFact(first.childForFieldName('type'), source) : undefined;
}

/** `typeParams` and single constraints (`tb:T`) of a generic type or function. */
export function genericFacts(params: Node | null | undefined, source: string): RefMetadata {
  const facts: RefMetadata = {};
  const names: string[] = [];
  for (const p of params?.namedChildren ?? []) {
    if (p?.type !== 'type_parameter_declaration') continue;
    const bound = typeFact(p.childForFieldName('type'), source);
    for (const n of p.childrenForFieldName('name')) {
      if (n?.type !== 'identifier') continue;
      const name = nodeText(source, n);
      names.push(name);
      if (bound) facts[`${BOUND_FACT_PREFIX}${name}`] = bound;
    }
  }
  if (names.length > 0) facts[FACT_TYPE_PARAMS] = names.join(',');
  return facts;
}

/** Type parameters a method's receiver introduces (`func (s *Stack[E]) …` → E). */
export function receiverTypeParams(node: Node, source: string): string | undefined {
  const param = node.childForFieldName('receiver')?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  let type = param?.childForFieldName('type') ?? null;
  while (type?.type === 'pointer_type' || type?.type === 'parenthesized_type') type = type.namedChildren[0] ?? null;
  if (type?.type !== 'generic_type') return undefined;
  const names = (type.childForFieldName('type_arguments')?.namedChildren ?? []).flatMap((a) => {
    const t = a?.namedChildren[0];
    return t?.type === 'type_identifier' ? [nodeText(source, t)] : [];
  });
  return names.length > 0 ? names.join(',') : undefined;
}
