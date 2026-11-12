import type { Node, Tree } from 'web-tree-sitter';
import type {
  GraphNode,
  NodeKind,
  RefMetadata,
} from '../../../../../../shared/domain/code-graph';
import {
  ExtractionBuilder,
  headerText,
  nodeText,
  unquote,
  walk,
  type FileExtraction,
  type LanguageExtractor,
  type SymbolInit,
} from '../extractor';
import { FACT_RETURNS, FACT_TYPE, FACT_TYPE_PARAMS } from '../type-facts';
import { genericFacts, GoLocals, receiverTypeParams, returnFact, typeFact } from './go-types';

// Adapted from codegraph (MIT), src/extraction/languages/go.ts.
//
// Symbols: the package (namespace), package-level types, functions, methods, constants and
// variables, struct fields and interface methods. Function-local declarations, closures and
// anonymous structs are never symbols; calls inside closures hang off the enclosing symbol.
// Types are declared before the walk so methods can find their receiver type wherever it sits.
// `implements` is not inferred: Go is structural and the resolver matches method sets.

interface Ctx {
  source: string;
  b: ExtractionBuilder;
  /** Package-level type name → its symbol, for receiver lookup. */
  types: Map<string, GraphNode>;
  /** Locals and parameters in scope, for receiver type facts (go-types.ts). */
  locals: GoLocals;
}

const TYPE_REF_NODES: ReadonlySet<string> = new Set([
  'type_identifier',
  'qualified_type',
  'generic_type',
]);

export const goExtractor: LanguageExtractor = {
  language: 'go',
  extensions: ['.go'],
  extract(relPath: string, source: string, tree: Tree): FileExtraction {
    const b = new ExtractionBuilder(relPath, 'go', tree.rootNode);
    const ctx: Ctx = { source, b, types: new Map(), locals: new GoLocals(source) };
    try {
      for (const top of topLevel(tree.rootNode)) {
        if (top.type === 'package_clause') declarePackage(top, ctx);
        else if (top.type === 'type_declaration') declareTypes(top, ctx);
      }
      walk(tree.rootNode, (node) => {
        b.noteSyntaxError(node);
        ctx.locals.declareBindings(node);
        switch (node.type) {
          case 'function_declaration':
            return declareFunction(node, ctx);
          case 'method_declaration':
            return declareMethod(node, ctx);
          case 'import_spec':
            return visitImport(node, ctx);
          case 'const_declaration':
            return declareValues(node, 'constant', ctx);
          case 'var_declaration':
            return declareValues(node, 'variable', ctx);
          case 'call_expression':
            return visitCall(node, ctx);
          case 'composite_literal':
            return visitLiteral(node, ctx);
          default:
            return undefined;
        }
      });
    } catch (err) {
      b.addError(
        `extraction failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return b.result;
  },
};

/** Direct children of the file; ERROR nodes are transparent so recovered declarations still count. */
function topLevel(root: Node): Node[] {
  const out: Node[] = [];
  for (const child of root.namedChildren) {
    if (!child) continue;
    if (child.type === 'ERROR') out.push(...topLevel(child));
    else out.push(child);
  }
  return out;
}

function isTopLevel(node: Node): boolean {
  let parent = node.parent;
  while (parent?.type === 'ERROR') parent = parent.parent;
  return parent?.type === 'source_file';
}

function declarePackage(node: Node, ctx: Ctx): void {
  const name = node.namedChildren.find((c) => c?.type === 'package_identifier');
  if (!name) return;
  const init: SymbolInit = {
    kind: 'namespace',
    name: nodeText(ctx.source, name),
    syntax: node,
  };
  const doc = docOf(node, ctx.source);
  if (doc) init.docstring = doc;
  ctx.b.addSymbol(init, ctx.b.file);
}

function declareTypes(decl: Node, ctx: Ctx): void {
  const { b, source } = ctx;
  for (const spec of decl.namedChildren) {
    if (spec?.type !== 'type_spec' && spec?.type !== 'type_alias') continue;
    const nameNode = spec.childForFieldName('name');
    if (!nameNode) continue;
    const name = nodeText(source, nameNode);
    const typeNode = spec.childForFieldName('type');
    const isAlias = spec.type === 'type_alias';
    let kind: NodeKind = 'type_alias';
    if (!isAlias && typeNode?.type === 'struct_type') kind = 'class';
    else if (!isAlias && typeNode?.type === 'interface_type')
      kind = 'interface';

    let signature = `type ${headerText(source, spec)}`;
    if (kind !== 'type_alias') signature = signature.replace(/\s*\{.*$/s, '');
    const init: SymbolInit = {
      kind,
      name,
      syntax: spec,
      signature,
      ...exportInfo(name),
    };
    const facts: RefMetadata = genericFacts(spec.childForFieldName('type_parameters'), source);
    if (kind === 'class') facts['goKind'] = 'struct';
    if (Object.keys(facts).length > 0) init.metadata = facts;
    const doc =
      docOf(decl.namedChildren.length === 1 ? decl : spec, source) ??
      docOf(spec, source);
    if (doc) init.docstring = doc;
    const symbol = b.addSymbol(init, b.file);
    ctx.types.set(name, symbol);

    if (kind === 'class' && typeNode) declareFields(typeNode, symbol, ctx);
    else if (kind === 'interface' && typeNode)
      declareInterface(typeNode, symbol, ctx);
  }
}

function declareFields(structType: Node, owner: GraphNode, ctx: Ctx): void {
  const { b, source } = ctx;
  const list = structType.namedChildren.find(
    (c) => c?.type === 'field_declaration_list',
  );
  for (const field of list?.namedChildren ?? []) {
    if (field?.type !== 'field_declaration') continue;
    const names = field
      .childrenForFieldName('name')
      .filter((n): n is Node => n !== null && n.isNamed);
    const type = field.childForFieldName('type');
    const fact = typeFact(type, source);
    const signature = headerText(source, field);
    const doc = docOf(field, source);
    if (names.length === 0) {
      const ref = type ? typeRefName(type, source) : undefined;
      if (!type || !ref) continue;
      const init: SymbolInit = {
        kind: 'field',
        name: ref.slice(ref.lastIndexOf('.') + 1),
        syntax: field,
        signature,
        metadata: fact ? { embedded: true, [FACT_TYPE]: fact } : { embedded: true },
        ...exportInfo(ref.slice(ref.lastIndexOf('.') + 1)),
      };
      if (doc) init.docstring = doc;
      b.addSymbol(init, owner);
      b.addRef(owner.id, ref, 'extends', type, { embedded: true });
      continue;
    }
    for (const nameNode of names) {
      const name = nodeText(source, nameNode);
      const init: SymbolInit = {
        kind: 'field',
        name,
        syntax: field,
        signature,
        ...exportInfo(name),
      };
      if (fact) init.metadata = { [FACT_TYPE]: fact };
      if (doc) init.docstring = doc;
      b.addSymbol(init, owner);
    }
  }
}

function declareInterface(
  interfaceType: Node,
  owner: GraphNode,
  ctx: Ctx,
): void {
  const { b, source } = ctx;
  for (const elem of interfaceType.namedChildren) {
    if (elem?.type === 'method_elem') {
      const nameNode = elem.childForFieldName('name');
      if (!nameNode) continue;
      const name = nodeText(source, nameNode);
      const init: SymbolInit = {
        kind: 'method',
        name,
        syntax: elem,
        signature: headerText(source, elem),
        ...exportInfo(name),
      };
      const returns = returnFact(elem, source);
      if (returns) init.metadata = { [FACT_RETURNS]: returns };
      const doc = docOf(elem, source);
      if (doc) init.docstring = doc;
      b.addSymbol(init, owner);
    } else if (elem?.type === 'type_elem' && elem.namedChildCount === 1) {
      const type = elem.namedChildren[0];
      const ref =
        type && TYPE_REF_NODES.has(type.type)
          ? typeRefName(type, source)
          : undefined;
      if (type && ref)
        b.addRef(owner.id, ref, 'extends', type, { embedded: true });
    }
  }
}

function declareFunction(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const nameNode = node.childForFieldName('name');
  if (!nameNode || !isTopLevel(node)) return undefined;
  const name = nodeText(source, nameNode);
  const init: SymbolInit = {
    kind: 'function',
    name,
    syntax: node,
    signature: headerText(source, node, node.childForFieldName('body')),
    ...exportInfo(name),
  };
  const facts = genericFacts(node.childForFieldName('type_parameters'), source);
  const returns = returnFact(node, source);
  if (returns) facts[FACT_RETURNS] = returns;
  if (Object.keys(facts).length > 0) init.metadata = facts;
  const doc = docOf(node, source);
  if (doc) init.docstring = doc;
  b.enterScope(node, b.addSymbol(init, b.file));
  return undefined;
}

function declareMethod(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const nameNode = node.childForFieldName('name');
  if (!nameNode || !isTopLevel(node)) return undefined;
  const name = nodeText(source, nameNode);
  const receiver = receiverOf(node, source);
  const init: SymbolInit = {
    kind: 'method',
    name,
    syntax: node,
    signature: headerText(source, node, node.childForFieldName('body')),
    ...exportInfo(name),
  };
  const facts: RefMetadata = {};
  if (receiver?.pointer) facts['pointerReceiver'] = true;
  const returns = returnFact(node, source);
  if (returns) facts[FACT_RETURNS] = returns;
  // Receiver type parameters (`Stack[E]`) are unbound in the method, never project types.
  const typeParams = receiverTypeParams(node, source);
  if (typeParams) facts[FACT_TYPE_PARAMS] = typeParams;
  if (Object.keys(facts).length > 0) init.metadata = facts;
  const doc = docOf(node, source);
  if (doc) init.docstring = doc;

  let parent = b.file;
  if (receiver) {
    // A receiver type declared elsewhere keeps the file as `contains` source but still qualifies the name.
    parent = ctx.types.get(receiver.name) ?? {
      ...b.file,
      qualifiedName: receiver.name,
    };
  }
  b.enterScope(node, b.addSymbol(init, parent));
  return undefined;
}

function receiverOf(
  node: Node,
  source: string,
): { name: string; pointer: boolean } | undefined {
  const param = node
    .childForFieldName('receiver')
    ?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  let type = param?.childForFieldName('type') ?? null;
  let pointer = false;
  while (type?.type === 'pointer_type' || type?.type === 'parenthesized_type') {
    if (type.type === 'pointer_type') pointer = true;
    type = type.namedChildren[0] ?? null;
  }
  const name = type ? typeRefName(type, source) : undefined;
  return name ? { name, pointer } : undefined;
}

function visitImport(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const pathNode = node.childForFieldName('path');
  if (!pathNode) return undefined;
  const spec = unquote(nodeText(source, pathNode));
  const alias = node.childForFieldName('name');
  const meta: RefMetadata = {};
  if (alias?.type === 'blank_identifier') meta.blank = true;
  else if (alias?.type === 'dot') meta.dot = true;
  else if (alias) meta.alias = nodeText(source, alias);
  meta.binding = alias
    ? nodeText(source, alias)
    : spec.slice(spec.lastIndexOf('/') + 1);
  b.addSymbol(
    {
      kind: 'import',
      name: spec,
      syntax: node,
      signature: headerText(source, node),
    },
    b.file,
  );
  b.addRef(b.file.id, spec, 'imports', node, meta);
  return undefined;
}

function declareValues(
  decl: Node,
  kind: 'constant' | 'variable',
  ctx: Ctx,
): undefined {
  const { b, source } = ctx;
  if (!isTopLevel(decl)) return undefined;
  const specType = kind === 'constant' ? 'const_spec' : 'var_spec';
  const specs = decl.namedChildren.flatMap((c) =>
    c?.type === 'var_spec_list' ? c.namedChildren : [c],
  );
  const declDoc = docOf(decl, source);
  for (const spec of specs) {
    if (spec?.type !== specType) continue;
    const signature = headerText(source, spec);
    const doc =
      (specs.length === 1 ? declDoc : undefined) ?? docOf(spec, source);
    for (const nameNode of spec.childrenForFieldName('name')) {
      if (!nameNode?.isNamed) continue;
      const name = nodeText(source, nameNode);
      if (name === '_') continue;
      const init: SymbolInit = {
        kind,
        name,
        syntax: spec,
        signature,
        ...exportInfo(name),
      };
      if (doc) init.docstring = doc;
      const values = spec.childForFieldName('value')?.namedChildren ?? [];
      const names = spec.childrenForFieldName('name').filter((n) => n?.isNamed);
      const fact =
        typeFact(spec.childForFieldName('type'), source) ??
        (values.length === names.length ? ctx.locals.exprFact(values[names.findIndex((n) => n?.id === nameNode.id)]) : undefined);
      if (fact && kind === 'variable') init.metadata = { [FACT_TYPE]: fact };
      b.addSymbol(init, b.file);
    }
  }
  return undefined;
}

function visitCall(node: Node, ctx: Ctx): undefined {
  const fn = node.childForFieldName('function');
  const name = fn ? calleeName(fn, ctx.source) : undefined;
  if (!fn || !name) return undefined;
  const operand = fn.type === 'selector_expression' ? fn.childForFieldName('operand') : null;
  const named = operand ? receiverName(operand, ctx.source) !== undefined : true;
  ctx.b.addRef(ctx.b.scopeAt(node).node.id, name, 'calls', node, ctx.locals.callMetadata(fn, named));
  return undefined;
}

function visitLiteral(node: Node, ctx: Ctx): undefined {
  const type = node.childForFieldName('type');
  const name = type ? typeRefName(type, ctx.source) : undefined;
  if (name)
    ctx.b.addRef(ctx.b.scopeAt(node).node.id, name, 'instantiates', node);
  return undefined;
}

/** `helper`, `pkg.Func`, `a.b.M`; a computed receiver (`f().M`) leaves just the method name. */
function calleeName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'identifier':
      return nodeText(source, node);
    case 'parenthesized_expression':
      return node.namedChildren[0]
        ? calleeName(node.namedChildren[0], source)
        : undefined;
    case 'selector_expression': {
      const field = node.childForFieldName('field');
      if (!field) return undefined;
      const operand = node.childForFieldName('operand');
      const receiver = operand ? receiverName(operand, source) : undefined;
      const name = nodeText(source, field);
      return receiver ? `${receiver}.${name}` : name;
    }
    case 'index_expression': {
      const operand = node.childForFieldName('operand');
      return operand ? calleeName(operand, source) : undefined;
    }
    default:
      return undefined;
  }
}

function receiverName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'identifier':
    case 'package_identifier':
      return nodeText(source, node);
    case 'selector_expression': {
      const field = node.childForFieldName('field');
      const operand = node.childForFieldName('operand');
      const receiver = operand ? receiverName(operand, source) : undefined;
      return field && receiver
        ? `${receiver}.${nodeText(source, field)}`
        : undefined;
    }
    default:
      return undefined;
  }
}

/** Type reference without type arguments or pointer: `*pkg.T` → `pkg.T`, `Stack[int]` → `Stack`. */
function typeRefName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'type_identifier':
      return nodeText(source, node);
    case 'qualified_type':
      return nodeText(source, node).replace(/\s+/g, '');
    case 'generic_type': {
      const inner = node.childForFieldName('type');
      return inner ? typeRefName(inner, source) : undefined;
    }
    case 'pointer_type':
    case 'parenthesized_type': {
      const inner = node.namedChildren[0];
      return inner ? typeRefName(inner, source) : undefined;
    }
    default:
      return undefined;
  }
}

function exportInfo(name: string): {
  isExported: boolean;
  visibility: 'public' | 'private';
} {
  const exported = /^\p{Lu}/u.test(name);
  return { isExported: exported, visibility: exported ? 'public' : 'private' };
}

/** The comment block directly above a declaration (no blank line, not a trailing comment of the previous one). */
function docOf(node: Node, source: string): string | undefined {
  const lines: string[] = [];
  let expectedRow = node.startPosition.row;
  for (
    let c = node.previousSibling;
    c?.type === 'comment' && c.endPosition.row === expectedRow - 1;
    c = c.previousSibling
  ) {
    const before = c.previousSibling;
    if (
      before &&
      before.type !== 'comment' &&
      before.endPosition.row === c.startPosition.row
    )
      break;
    lines.unshift(commentText(nodeText(source, c)));
    expectedRow = c.startPosition.row;
  }
  const doc = lines.join('\n').trim();
  return doc || undefined;
}

function commentText(text: string): string {
  if (text.startsWith('//')) return text.replace(/^\/\/ ?/, '').trimEnd();
  return text
    .slice(2, -2)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trim())
    .join('\n')
    .trim();
}
