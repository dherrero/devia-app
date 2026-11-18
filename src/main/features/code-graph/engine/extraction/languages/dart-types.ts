import type { Node } from 'web-tree-sitter';
import type { RefMetadata } from '../../../../../../shared/domain/code-graph';
import { nodeText } from '../extractor';
import { ScopeStack, type Span } from '../local-scopes';
import {
  BOUND_FACT_PREFIX,
  extendChain,
  FACT_TYPE_PARAMS,
  REF_HEAD_TYPE,
  REF_OWNER_TYPE,
  typeExpr,
  UNKNOWN_TYPE,
} from '../type-facts';

// Receiver type facts for Dart (S-44 T-515), in the shared TypeExpr form of type-facts.ts.
// The vendored grammar is flat: a type is a run of sibling tokens (`p.Foo<A>?`) and an
// expression is a head followed by `selector` siblings (`a` `.b` `(…)`), so both are read from
// sibling lists. Declared types win; `final x = Foo()` / `var x = a.b()` fall back to the
// initializer. `this.x` constructor parameters are the field itself and are not locals. An
// awaited value is not followed (its declared type is the Future, not the value).

const SIGNATURES: ReadonlySet<string> = new Set([
  'function_signature',
  'getter_signature',
  'setter_signature',
  'constructor_signature',
  'constant_constructor_signature',
  'factory_constructor_signature',
  'redirecting_factory_constructor_signature',
]);

const PARAM_LISTS: ReadonlySet<string> = new Set(['formal_parameter_list', 'optional_formal_parameters', 'ERROR']);

export class DartLocals extends ScopeStack {
  constructor(private readonly source: string) {
    super();
  }

  /** Names a node brings into scope before its children are walked. */
  declareBindings(node: Node): void {
    if (SIGNATURES.has(node.type)) {
      const params = node.namedChildren.find((c) => c?.type === 'formal_parameter_list');
      if (params) this.declareParams(params, { startIndex: node.startIndex, endIndex: signatureEnd(node) });
      return;
    }
    switch (node.type) {
      case 'function_expression': {
        const params = node.childForFieldName('parameters');
        if (params) this.declareParams(params, node);
        return;
      }
      case 'initialized_variable_definition': {
        const scope = node.parent?.parent;
        if (!scope) return;
        const declared = typeFact(node.children, this.source);
        const name = node.childForFieldName('name');
        if (name)
          this.declare(nodeText(this.source, name), declared ?? this.chainFact(node.childrenForFieldName('value')), scope, node.startIndex);
        for (const extra of node.namedChildren) {
          if (extra?.type !== 'initialized_identifier') continue;
          const [id, ...value] = extra.namedChildren;
          if (id?.type === 'identifier')
            this.declare(nodeText(this.source, id), declared ?? this.chainFact(value), scope, extra.startIndex);
        }
        return;
      }
      case 'for_loop_parts': {
        const name = node.childForFieldName('name');
        const loop = node.parent;
        if (name && loop) this.declare(nodeText(this.source, name), typeFact(node.children, this.source), loop, node.startIndex);
        return;
      }
      case 'catch_clause': {
        const ids = node.namedChildren.find((c) => c?.type === 'catch_parameters')?.namedChildren ?? [];
        const body = node.nextNamedSibling;
        if (!body || body.type !== 'block') return;
        ids.forEach((id, i) => {
          if (id?.type === 'identifier') this.declare(nodeText(this.source, id), i === 0 ? this.onType(node) : undefined, body);
        });
        return;
      }
      default:
        return;
    }
  }

  /** `on T catch (e)`: the type tokens between `on` and the catch clause. */
  private onType(clause: Node): string | undefined {
    const tokens: Node[] = [];
    for (let p = clause.previousSibling; p; p = p.previousSibling) {
      if (p.type === 'on') return typeFact(tokens, this.source);
      if (p.type === 'catch_clause' || p.type === 'block') return undefined;
      tokens.unshift(p);
    }
    return undefined;
  }

  private declareParams(list: Node, scope: Span): void {
    for (const p of list.namedChildren) {
      if (!p) continue;
      if (PARAM_LISTS.has(p.type)) {
        this.declareParams(p, scope);
        continue;
      }
      if (p.type !== 'formal_parameter') continue;
      if (p.namedChildren.some((c) => c?.type === 'constructor_param' || c?.type === 'super_formal_parameter')) continue;
      const name = p.childForFieldName('name') ?? (p.namedChildren.length === 1 ? p.namedChildren[0] : null);
      if (name?.type === 'identifier') this.declare(nodeText(this.source, name), typeFact(p.children, this.source), scope);
    }
  }

  /**
   * The TypeExpr of a flat expression: a head and its selectors. Undefined when nothing can be
   * said (a literal, an index, an awaited value, a call on a value).
   */
  chainFact(nodes: (Node | null)[]): string | undefined {
    const [head, ...selectors] = nodes.filter((n): n is Node => n !== null && n.isNamed);
    if (!head) return undefined;
    let fact: string | undefined;
    let bare = false;
    switch (head.type) {
      case 'identifier': {
        const name = nodeText(this.source, head);
        const local = this.find(name, head);
        fact = local ? local.fact : `=${name}`;
        bare = !local;
        break;
      }
      case 'this':
        fact = '=this';
        break;
      case 'new_expression':
      case 'const_object_expression':
        fact = typeFact(head.children, this.source);
        break;
      case 'parenthesized_expression':
        fact = this.chainFact(head.namedChildren);
        break;
      case 'type_cast_expression':
        fact = typeFact(head.namedChildren.find((c) => c?.type === 'type_cast')?.children ?? [], this.source);
        break;
      default:
        return undefined;
    }
    let pending: string | undefined;
    for (const sel of selectors) {
      if (fact === undefined) return undefined;
      if (sel.type !== 'selector') return undefined;
      const inner = sel.namedChildren[0];
      if (!inner) continue; // `!`
      if (inner.type === 'unconditional_assignable_selector' || inner.type === 'conditional_assignable_selector') {
        const id = inner.namedChildren[0];
        if (id?.type !== 'identifier' || inner.namedChildren.length !== 1) return undefined;
        if (pending !== undefined) fact = extendChain(fact, pending, false);
        pending = nodeText(this.source, id);
        bare = false;
      } else if (inner.type === 'argument_part') {
        if (pending !== undefined) fact = extendChain(fact, pending, true);
        else if (bare) fact = `${fact}()`;
        else return undefined;
        pending = undefined;
        bare = false;
      } else {
        return undefined;
      }
    }
    if (fact !== undefined && pending !== undefined) fact = extendChain(fact, pending, false);
    return fact;
  }

  /**
   * Metadata for the call whose argument selector is `call`: `headType` when the callee chain
   * starts at a local or parameter, `ownerType` when its receiver is computed. Mirrors the
   * extractor's callee naming: a plain head with simple `.name` selectors keeps a dotted name.
   */
  callMetadata(call: Node): RefMetadata | undefined {
    const selectors: Node[] = [];
    let p = call.previousSibling;
    for (; p?.type === 'selector'; p = p.previousSibling) selectors.unshift(p);
    const head = p;
    const last = selectors[selectors.length - 1];
    if (!last || !isSimpleSelector(last)) {
      if (selectors.length === 0 && head?.type === 'identifier' && this.find(nodeText(this.source, head), head))
        return { [REF_HEAD_TYPE]: UNKNOWN_TYPE };
      return undefined;
    }
    const plainHead = head?.type === 'identifier' || head?.type === 'this' || head?.type === 'super';
    if (plainHead && selectors.every(isSimpleSelector)) {
      if (head?.type !== 'identifier') return undefined;
      const local = this.find(nodeText(this.source, head), head);
      return local ? { [REF_HEAD_TYPE]: local.fact ?? UNKNOWN_TYPE } : undefined;
    }
    return { [REF_OWNER_TYPE]: (head && this.chainFact([head, ...selectors.slice(0, -1)])) ?? UNKNOWN_TYPE };
  }

  /** `x..a()..b()`: the receiver of every section is the expression before the first one. */
  cascadeMetadata(section: Node): RefMetadata {
    let p = section.previousSibling;
    while (p?.type === 'cascade_section') p = p.previousSibling;
    const selectors: Node[] = [];
    for (; p?.type === 'selector'; p = p.previousSibling) selectors.unshift(p);
    return { [REF_OWNER_TYPE]: (p && this.chainFact([p, ...selectors])) ?? UNKNOWN_TYPE };
  }
}

function isSimpleSelector(sel: Node): boolean {
  const inner = sel.namedChildren[0];
  return (
    (inner?.type === 'unconditional_assignable_selector' || inner?.type === 'conditional_assignable_selector') &&
    inner.namedChildren.length === 1 &&
    inner.namedChildren[0]?.type === 'identifier'
  );
}

/** A signature's parameters are visible in its sibling body (or, for a method, its holder's). */
function signatureEnd(sig: Node): number {
  const holder = sig.parent?.type === 'method_signature' || sig.parent?.type === 'declaration' ? sig.parent : sig;
  let n = holder.nextSibling;
  while (n && (n.type === 'comment' || n.type === 'documentation_comment')) n = n.nextSibling;
  return n?.type === 'function_body' ? n.endIndex : holder.endIndex;
}

/**
 * The first type in a flat run of tokens (`final`, `p`, `.`, `Foo`, `<…>`, `?`, name…):
 * `p.Foo<A, B>`. Undefined without one, or for `void`, functions and records.
 */
export function typeFact(tokens: readonly (Node | null)[], source: string): string | undefined {
  return typeList(tokens, source, true)[0];
}

function typeList(tokens: readonly (Node | null)[], source: string, firstOnly: boolean): (string | undefined)[] {
  const out: { name: string; args: (string | undefined)[] }[] = [];
  let afterDot = false;
  for (const t of tokens) {
    if (!t) continue;
    const last = out[out.length - 1];
    if (t.type === 'type_identifier' || (afterDot && t.type === 'identifier')) {
      if (afterDot && last) {
        last.name += `.${nodeText(source, t)}`;
      } else {
        if (firstOnly && last) break;
        out.push({ name: nodeText(source, t), args: [] });
      }
      afterDot = false;
      continue;
    }
    if (t.type === '.') {
      afterDot = last !== undefined;
      continue;
    }
    afterDot = false;
    if (t.type === 'type_arguments') {
      if (last) last.args = typeList(t.children, source, false);
    } else if (t.type === 'identifier' || t.type === 'arguments' || t.type === 'formal_parameter_list') {
      break;
    } else if (t.type === 'void_type' || t.type === 'function_type' || t.type === 'record_type' || t.type === 'inferred_type') {
      if (firstOnly) {
        if (!last) return [];
        break;
      }
      // Keeps the slot, so later arguments still bind the right type parameter.
      out.push({ name: '', args: [] });
    }
  }
  return out.map((e) => (e.name ? typeExpr(e.name, e.args) : undefined));
}

/** `typeParams` and single upper bounds (`tb:T`) of a generic class or function. */
export function genericFacts(holder: Node | undefined, source: string): RefMetadata {
  const facts: RefMetadata = {};
  const params = holder?.namedChildren.find((c) => c?.type === 'type_parameters');
  const names: string[] = [];
  for (const p of params?.namedChildren ?? []) {
    if (p?.type !== 'type_parameter') continue;
    const name = p.namedChildren.find((c) => c?.type === 'type_identifier');
    if (!name) continue;
    const n = nodeText(source, name);
    names.push(n);
    const bound = p.namedChildren.find((c) => c?.type === 'type_bound');
    const fact = bound ? typeFact(bound.children, source) : undefined;
    if (fact) facts[`${BOUND_FACT_PREFIX}${n}`] = fact;
  }
  if (names.length > 0) facts[FACT_TYPE_PARAMS] = names.join(',');
  return facts;
}
