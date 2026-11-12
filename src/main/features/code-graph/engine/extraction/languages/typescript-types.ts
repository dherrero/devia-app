import type { Node } from 'web-tree-sitter';
import type { RefMetadata } from '../../../../../../shared/domain/code-graph';
import { nodeText } from '../extractor';
import {
  extendChain,
  REF_HEAD_TYPE,
  REF_OWNER_TYPE,
  typeExpr,
  UNKNOWN_TYPE,
} from '../type-facts';
import { ScopeStack } from '../local-scopes';

// Receiver type facts for TypeScript/JavaScript (S-44 T-515), in the shared TypeExpr form of
// type-facts.ts. Declared types win; otherwise the initializer decides (`new X<A>()`, `x as X`,
// a call or member chain, which the resolver evaluates through declared return/field types).
// Locals and parameters are not graph nodes, so their facts are tracked here, per lexical scope,
// while the extractor walks the file, and land on the refs that use them.

export const FUNCTION_LIKE: ReadonlySet<string> = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_expression',
  'function',
  'generator_function',
  'arrow_function',
  'method_definition',
]);

export interface ParameterProperty {
  name: string;
  fact: string | undefined;
}

/** The locals and parameters in scope at the walk's position (walk visits in document order). */
export class LocalScopes extends ScopeStack {
  constructor(private readonly source: string) {
    super();
  }

  /** Parameters of a function-like node; returns its constructor parameter properties. */
  declareParameters(fn: Node): ParameterProperty[] {
    const props: ParameterProperty[] = [];
    const single = fn.childForFieldName('parameter');
    if (single) {
      this.declarePattern(single, undefined, fn);
      return props;
    }
    const params = fn.childForFieldName('parameters');
    const isConstructor =
      fn.type === 'method_definition' && nodeText(this.source, fn.childForFieldName('name') ?? fn) === 'constructor';
    for (const p of params?.namedChildren ?? []) {
      if (!p || (p.type !== 'required_parameter' && p.type !== 'optional_parameter')) continue;
      const pattern = p.childForFieldName('pattern');
      if (!pattern) continue;
      const fact = typeFact(p.childForFieldName('type'), this.source);
      this.declarePattern(pattern, fact, fn);
      const isProperty = p.children.some((c) => c?.type === 'accessibility_modifier' || c?.type === 'readonly');
      if (isConstructor && isProperty && pattern.type === 'identifier')
        props.push({ name: nodeText(this.source, pattern), fact });
    }
    return props;
  }

  /** Every name a binding pattern introduces; only a plain identifier keeps the declared type. */
  declarePattern(pattern: Node, fact: string | undefined, scope: Node): void {
    if (pattern.type === 'identifier') {
      this.declare(nodeText(this.source, pattern), fact, scope);
      return;
    }
    const visit = (n: Node): void => {
      if (n.type === 'identifier' || n.type === 'shorthand_property_identifier_pattern') {
        this.declare(nodeText(this.source, n), undefined, scope);
        return;
      }
      for (const c of n.namedChildren) {
        // In `{ key: value }` patterns only the value side binds; defaults are expressions.
        if (!c || n.childForFieldName('key')?.id === c.id || n.childForFieldName('right')?.id === c.id) continue;
        visit(c);
      }
    };
    visit(pattern);
  }

  /**
   * The TypeExpr of an expression used as a value: `new X<A>()`, `x as X`, `this.a.b()`, a
   * local's own fact, `f()` / `imported.member`. Undefined when nothing can be said.
   */
  exprFact(expr: Node | null): string | undefined {
    if (!expr) return undefined;
    switch (expr.type) {
      case 'new_expression': {
        const ctor = expr.childForFieldName('constructor');
        const name = ctor ? staticName(ctor, this.source) : undefined;
        if (!name || !ctor || this.find(name.split('.')[0] ?? name, ctor)) return undefined;
        const args = expr.childForFieldName('type_arguments');
        return typeExpr(name, (args?.namedChildren ?? []).map((a) => (a ? typeFact(a, this.source) : undefined)));
      }
      case 'as_expression':
      case 'satisfies_expression': {
        const type = expr.namedChildren[expr.namedChildren.length - 1] ?? null;
        return expr.type === 'as_expression' ? typeFact(type, this.source) : this.exprFact(expr.namedChildren[0] ?? null);
      }
      case 'non_null_expression':
      case 'parenthesized_expression':
        return this.exprFact(expr.namedChildren[0] ?? null);
      case 'this':
        return '=this';
      case 'identifier': {
        const name = nodeText(this.source, expr);
        const local = this.find(name, expr);
        if (local) return local.fact;
        return name === 'undefined' ? undefined : `=${name}`;
      }
      case 'member_expression': {
        const object = expr.childForFieldName('object');
        const property = expr.childForFieldName('property');
        const base = this.exprFact(object);
        return base && property ? extendChain(base, nodeText(this.source, property), false) : undefined;
      }
      case 'call_expression': {
        const callee = expr.childForFieldName('function');
        if (!callee) return undefined;
        if (callee.type === 'identifier') {
          const name = nodeText(this.source, callee);
          return this.find(name, callee) ? undefined : `=${name}()`;
        }
        if (callee.type !== 'member_expression') return undefined;
        const base = this.exprFact(callee.childForFieldName('object'));
        const property = callee.childForFieldName('property');
        return base && property ? extendChain(base, nodeText(this.source, property), true) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Ref metadata for a call/new whose callee is `callee`: `headType` when the name starts with a
   * local or parameter, `ownerType` when the receiver is computed (`a().b()`, `(x as T).m()`).
   */
  receiverMetadata(callee: Node): RefMetadata | undefined {
    let base = callee;
    while (base.type === 'member_expression') {
      const object = base.childForFieldName('object');
      if (!object) return undefined;
      base = object;
    }
    if (base.id === callee.id) {
      if (base.type !== 'identifier') return undefined;
      // A bare call of a local (a callback parameter, `const f = …; f()`) is not a symbol.
      const local = this.find(nodeText(this.source, base), base);
      return local ? { [REF_HEAD_TYPE]: UNKNOWN_TYPE } : undefined;
    }
    if (base.type === 'identifier') {
      const local = this.find(nodeText(this.source, base), base);
      return local ? { [REF_HEAD_TYPE]: local.fact ?? UNKNOWN_TYPE } : undefined;
    }
    if (base.type === 'this' || base.type === 'super') return undefined;
    return { [REF_OWNER_TYPE]: this.exprFact(base) ?? UNKNOWN_TYPE };
  }
}

/** `a`, `a.b.c` for identifiers/member chains only. */
function staticName(node: Node, source: string): string | undefined {
  if (node.type === 'identifier' || node.type === 'type_identifier') return nodeText(source, node);
  if (node.type !== 'member_expression' && node.type !== 'nested_identifier') return undefined;
  const text = nodeText(source, node).replace(/\s+/g, '');
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/.test(text) ? text : undefined;
}

/** A type annotation as a TypeExpr; undefined for anything without members worth following. */
export function typeFact(node: Node | null | undefined, source: string): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'type_annotation':
    case 'parenthesized_type':
      return typeFact(node.namedChildren[node.namedChildren.length - 1], source);
    case 'type_identifier':
    case 'identifier':
      return nodeText(source, node);
    case 'nested_type_identifier':
      return staticName(node, source) ?? nodeText(source, node).replace(/\s+/g, '');
    case 'generic_type': {
      const name = node.childForFieldName('name');
      const args = node.childForFieldName('type_arguments');
      const base = typeFact(name, source);
      return base
        ? typeExpr(base, (args?.namedChildren ?? []).map((a) => (a ? typeFact(a, source) : undefined)))
        : undefined;
    }
    case 'union_type': {
      // `T | null | undefined` is still a T receiver; any other union is not one type.
      const members: Node[] = [];
      const collect = (n: Node): void => {
        if (n.type === 'union_type') for (const c of n.namedChildren) if (c) collect(c);
        else if (!isNullish(n, source)) members.push(n);
      };
      collect(node);
      return members.length === 1 ? typeFact(members[0], source) : undefined;
    }
    default:
      return undefined;
  }
}

function isNullish(n: Node, source: string): boolean {
  const text = nodeText(source, n);
  return (n.type === 'literal_type' || n.type === 'predefined_type') && (text === 'null' || text === 'undefined');
}

/** Generic parameter names of a declaration (`<T extends X, K>` → `T,K`). */
export function typeParamsFact(node: Node, source: string): string | undefined {
  const params = node.childForFieldName('type_parameters');
  const names = (params?.namedChildren ?? []).flatMap((p) => {
    const name = p?.type === 'type_parameter' ? p.childForFieldName('name') : null;
    return name ? [nodeText(source, name)] : [];
  });
  return names.length > 0 ? names.join(',') : undefined;
}
