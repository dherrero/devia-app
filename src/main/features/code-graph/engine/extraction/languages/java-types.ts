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

// Receiver type facts for Java (S-44 T-515), in the shared TypeExpr form of type-facts.ts.
// Java declares nearly every type, so declared types decide; only `var` falls back to the
// initializer. Parameters (methods, constructors, lambdas, record components), locals, enhanced
// for, catch, try-with-resources and pattern variables are tracked per lexical scope.

const PATTERN_SCOPES: ReadonlySet<string> = new Set([
  'switch_rule',
  'switch_block_statement_group',
  'block',
  'lambda_expression',
  'method_declaration',
  'constructor_declaration',
]);

export class JavaLocals extends ScopeStack {
  constructor(private readonly source: string) {
    super();
  }

  /** Names a node brings into scope before its children are walked. */
  declareBindings(node: Node): void {
    switch (node.type) {
      case 'method_declaration':
      case 'constructor_declaration':
      case 'record_declaration':
        this.declareFormals(node.childForFieldName('parameters'), node);
        return;
      case 'lambda_expression': {
        const params = node.childForFieldName('parameters');
        if (params?.type === 'identifier') {
          this.declare(nodeText(this.source, params), undefined, node);
        } else if (params?.type === 'inferred_parameters') {
          for (const p of params.namedChildren) if (p?.type === 'identifier') this.declare(nodeText(this.source, p), undefined, node);
        } else {
          this.declareFormals(params, node);
        }
        return;
      }
      case 'local_variable_declaration': {
        const scope = node.parent;
        if (!scope) return;
        const declared = typeFact(node.childForFieldName('type'), this.source);
        for (const d of node.namedChildren) {
          if (d?.type !== 'variable_declarator') continue;
          const name = d.childForFieldName('name');
          if (!name) continue;
          const fact = isVar(node.childForFieldName('type'), this.source)
            ? this.exprFact(d.childForFieldName('value'))
            : d.childForFieldName('dimensions')
              ? undefined
              : declared;
          this.declare(nodeText(this.source, name), fact, scope, d.startIndex);
        }
        return;
      }
      case 'enhanced_for_statement': {
        const name = node.childForFieldName('name');
        if (name) this.declare(nodeText(this.source, name), typeFact(node.childForFieldName('type'), this.source), node);
        return;
      }
      case 'catch_formal_parameter': {
        const name = node.childForFieldName('name');
        const types = node.namedChildren.find((c) => c?.type === 'catch_type')?.namedChildren ?? [];
        const fact = types.length === 1 ? typeFact(types[0], this.source) : undefined;
        if (name && node.parent) this.declare(nodeText(this.source, name), fact, node.parent);
        return;
      }
      case 'resource': {
        const name = node.childForFieldName('name');
        const tryStatement = node.parent?.parent;
        if (!name || !tryStatement) return;
        const type = node.childForFieldName('type');
        const fact = isVar(type, this.source) ? this.exprFact(node.childForFieldName('value')) : typeFact(type, this.source);
        this.declare(nodeText(this.source, name), fact, tryStatement, node.startIndex);
        return;
      }
      case 'instanceof_expression': {
        const name = node.childForFieldName('name');
        const scope = patternScope(node);
        if (name && scope)
          this.declare(nodeText(this.source, name), typeFact(node.childForFieldName('right'), this.source), scope, node.startIndex);
        return;
      }
      case 'type_pattern':
      case 'record_pattern_component': {
        const name = node.namedChildren[node.namedChildren.length - 1];
        const scope = patternScope(node);
        if (name?.type === 'identifier' && scope)
          this.declare(nodeText(this.source, name), typeFact(node.namedChildren[0], this.source), scope, node.startIndex);
        return;
      }
      default:
        return;
    }
  }

  private declareFormals(params: Node | null, scope: Node): void {
    for (const p of params?.namedChildren ?? []) {
      if (p?.type === 'formal_parameter') {
        const name = p.childForFieldName('name');
        const fact = p.childForFieldName('dimensions') ? undefined : typeFact(p.childForFieldName('type'), this.source);
        if (name) this.declare(nodeText(this.source, name), fact, scope);
      } else if (p?.type === 'spread_parameter') {
        const name = p.namedChildren.find((c) => c?.type === 'variable_declarator')?.childForFieldName('name');
        if (name) this.declare(nodeText(this.source, name), undefined, scope);
      }
    }
  }

  /** The TypeExpr of an expression used as a receiver; undefined when nothing can be said. */
  exprFact(expr: Node | null | undefined): string | undefined {
    if (!expr) return undefined;
    switch (expr.type) {
      case 'object_creation_expression':
        if (expr.childForFieldName('object')) return undefined;
        return typeFact(expr.childForFieldName('type'), this.source);
      case 'cast_expression':
        return typeFact(expr.childForFieldName('type'), this.source);
      case 'parenthesized_expression':
        return this.exprFact(expr.namedChildren[0]);
      case 'this':
        return '=this';
      case 'identifier': {
        const name = nodeText(this.source, expr);
        const local = this.find(name, expr);
        return local ? local.fact : `=${name}`;
      }
      case 'field_access': {
        const object = expr.childForFieldName('object');
        const field = expr.childForFieldName('field');
        const base = object?.type === 'super' ? undefined : this.exprFact(object);
        return base && field ? extendChain(base, nodeText(this.source, field), false) : undefined;
      }
      case 'method_invocation': {
        const object = expr.childForFieldName('object');
        const name = expr.childForFieldName('name');
        if (!name) return undefined;
        if (!object) return `=${nodeText(this.source, name)}()`;
        const base = object.type === 'super' ? undefined : this.exprFact(object);
        return base ? extendChain(base, nodeText(this.source, name), true) : undefined;
      }
      default:
        return undefined;
    }
  }

  /**
   * Metadata for a `method_invocation`: `headType` when the receiver chain starts at a local or
   * parameter, `ownerType` when the receiver is computed (the ref name is then the bare method).
   * `receiverName` is the dotted receiver the ref name carries, if any.
   */
  callMetadata(object: Node | null, receiverName: string | undefined): RefMetadata | undefined {
    if (!object) return undefined;
    if (receiverName === undefined) return { [REF_OWNER_TYPE]: this.exprFact(object) ?? UNKNOWN_TYPE };
    let base = object;
    while (base.type === 'field_access') {
      const inner = base.childForFieldName('object');
      if (!inner) return undefined;
      base = inner;
    }
    if (base.type !== 'identifier') return undefined;
    const local = this.find(nodeText(this.source, base), base);
    return local ? { [REF_HEAD_TYPE]: local.fact ?? UNKNOWN_TYPE } : undefined;
  }
}

function isVar(type: Node | null, source: string): boolean {
  return type?.type === 'type_identifier' && nodeText(source, type) === 'var';
}

function patternScope(node: Node): Node | undefined {
  for (let n = node.parent; n; n = n.parent) if (PATTERN_SCOPES.has(n.type)) return n;
  return undefined;
}

/** A Java type as a TypeExpr: class types with their generic arguments; primitives and arrays have no members to follow. */
export function typeFact(node: Node | null | undefined, source: string): string | undefined {
  if (!node) return undefined;
  switch (node.type) {
    case 'type_identifier': {
      const text = nodeText(source, node);
      return text === 'var' ? undefined : text;
    }
    case 'scoped_type_identifier':
      return node.namedChildren.every((c) => c?.type === 'type_identifier')
        ? nodeText(source, node).replace(/\s+/g, '')
        : undefined;
    case 'generic_type': {
      const name = typeFact(
        node.namedChildren.find((c) => c?.type === 'type_identifier' || c?.type === 'scoped_type_identifier'),
        source,
      );
      const args = node.namedChildren.find((c) => c?.type === 'type_arguments');
      return name ? typeExpr(name, (args?.namedChildren ?? []).map((a) => typeFact(a, source))) : undefined;
    }
    case 'annotated_type':
      return typeFact(node.namedChildren[node.namedChildren.length - 1], source);
    default:
      return undefined;
  }
}

/** `typeParams` and single upper bounds (`tb:T`) of a generic class, interface or method. */
export function genericFacts(node: Node, source: string): RefMetadata {
  const facts: RefMetadata = {};
  const params = node.childForFieldName('type_parameters') ?? node.namedChildren.find((c) => c?.type === 'type_parameters');
  const names: string[] = [];
  for (const p of params?.namedChildren ?? []) {
    if (p?.type !== 'type_parameter') continue;
    const name = p.namedChildren.find((c) => c?.type === 'type_identifier' || c?.type === 'identifier');
    if (!name) continue;
    const n = nodeText(source, name);
    names.push(n);
    const bounds = p.namedChildren.find((c) => c?.type === 'type_bound')?.namedChildren ?? [];
    const bound = bounds.length === 1 ? typeFact(bounds[0], source) : undefined;
    if (bound) facts[`${BOUND_FACT_PREFIX}${n}`] = bound;
  }
  if (names.length > 0) facts[FACT_TYPE_PARAMS] = names.join(',');
  return facts;
}
