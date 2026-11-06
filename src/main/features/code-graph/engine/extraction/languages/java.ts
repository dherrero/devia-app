import type { Node, Tree } from 'web-tree-sitter';
import type { GraphNode, NodeKind, RefMetadata } from '../../../../../../shared/domain/code-graph';
import {
  ExtractionBuilder,
  headerText,
  nodeText,
  walk,
  type FileExtraction,
  type LanguageExtractor,
  type SymbolInit,
} from '../extractor';

// Adapted from codegraph (MIT), src/extraction/languages/java.ts.
//
// Symbols: the package (namespace), types declared at file level or directly in a type body, and
// their methods, constructors, fields and enum constants. Local classes, anonymous classes,
// lambdas and local variables are never symbols; calls inside them hang off the enclosing symbol.

const TYPE_KINDS: Readonly<Record<string, NodeKind>> = {
  class_declaration: 'class',
  record_declaration: 'class',
  annotation_type_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
};

const TYPE_BODIES: ReadonlySet<string> = new Set([
  'class_body',
  'interface_body',
  'annotation_type_body',
  'enum_body',
]);

const METHOD_NODES: ReadonlySet<string> = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);

const FIELD_NODES: ReadonlySet<string> = new Set(['field_declaration', 'constant_declaration']);

const VISIBILITIES = ['public', 'protected', 'private'] as const;

interface Ctx {
  source: string;
  b: ExtractionBuilder;
  namespace: GraphNode | undefined;
  /** Syntax node id → the symbol it declares. */
  owners: Map<number, GraphNode>;
}

export const javaExtractor: LanguageExtractor = {
  language: 'java',
  extensions: ['.java'],
  extract(relPath: string, source: string, tree: Tree): FileExtraction {
    const b = new ExtractionBuilder(relPath, 'java', tree.rootNode);
    const ctx: Ctx = { source, b, namespace: undefined, owners: new Map() };
    try {
      walk(tree.rootNode, (node) => {
        b.noteSyntaxError(node);
        const type = node.type;
        if (type in TYPE_KINDS) return declareType(node, ctx);
        if (METHOD_NODES.has(type)) return declareMethod(node, ctx);
        if (FIELD_NODES.has(type)) return declareFields(node, ctx);
        switch (type) {
          case 'package_declaration':
            return declarePackage(node, ctx);
          case 'import_declaration':
            return visitImport(node, ctx);
          case 'enum_constant':
            return declareEnumConstant(node, ctx);
          case 'method_invocation':
            return visitCall(node, ctx);
          case 'object_creation_expression':
            return visitNew(node, ctx);
          default:
            return undefined;
        }
      });
    } catch (err) {
      b.addError(`extraction failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return b.result;
  },
};

function declarePackage(node: Node, ctx: Ctx): undefined {
  const name = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier');
  if (!name || ctx.namespace) return undefined;
  ctx.namespace = ctx.b.addSymbol(
    { kind: 'namespace', name: compact(nodeText(ctx.source, name)), syntax: node },
    ctx.b.file,
  );
  return undefined;
}

function declareType(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const nameNode = node.childForFieldName('name');
  const parent = nameNode ? containerOf(node, ctx) : undefined;
  if (!nameNode || !parent) return undefined;
  const kind = TYPE_KINDS[node.type] ?? 'class';
  const init = baseInit(kind, nodeText(source, nameNode), node, parent, ctx);
  init.signature = headerText(source, node, node.childForFieldName('body'), headerStart(node));
  if (node.type === 'record_declaration') init.metadata = { javaKind: 'record' };
  if (node.type === 'annotation_type_declaration') init.metadata = { javaKind: 'annotation' };
  const symbol = addDeclared(init, node, parent, ctx);
  b.enterScope(node, symbol);

  const superclass = node.childForFieldName('superclass');
  for (const t of superclass?.namedChildren ?? []) addTypeRef(t, symbol, 'extends', ctx);
  const interfaces = node.childForFieldName('interfaces');
  for (const t of interfaces?.namedChildren.flatMap((c) => (c?.type === 'type_list' ? c.namedChildren : [c])) ?? []) {
    addTypeRef(t, symbol, 'implements', ctx);
  }
  const extendsList = node.namedChildren.find((c) => c?.type === 'extends_interfaces');
  for (const list of extendsList?.namedChildren ?? []) {
    for (const t of list?.type === 'type_list' ? list.namedChildren : [list]) addTypeRef(t, symbol, 'extends', ctx);
  }
  return undefined;
}

function declareMethod(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const nameNode = node.childForFieldName('name');
  const parent = nameNode ? containerOf(node, ctx) : undefined;
  if (!nameNode || !parent || !isTypeSymbol(parent)) return undefined;
  const name = nodeText(source, nameNode);
  const body = node.childForFieldName('body');
  const init = baseInit('method', name, node, parent, ctx);
  init.signature = headerText(source, node, body, headerStart(node));
  if (node.type !== 'method_declaration') init.metadata = { constructor: true };
  else if (
    parent.kind === 'interface' &&
    !body &&
    !hasModifier(node, 'default') &&
    !hasModifier(node, 'static') &&
    !hasModifier(node, 'private')
  ) {
    init.isAbstract = true;
  }
  const symbol = addDeclared(init, node, parent, ctx);
  b.enterScope(node, symbol);
  if (annotationsOf(node).some((a) => annotationName(a, source) === 'Override')) {
    b.addRef(symbol.id, name, 'overrides', nameNode);
  }
  return undefined;
}

function declareFields(node: Node, ctx: Ctx): undefined {
  const { source } = ctx;
  const parent = containerOf(node, ctx);
  if (!parent || !isTypeSymbol(parent)) return undefined;
  const signature = headerText(source, node, null, headerStart(node));
  for (const decl of node.namedChildren) {
    if (decl?.type !== 'variable_declarator') continue;
    const nameNode = decl.childForFieldName('name');
    if (!nameNode) continue;
    const init = baseInit('field', nodeText(source, nameNode), node, parent, ctx);
    init.signature = signature;
    if (parent.kind === 'interface') init.isStatic = true;
    addDeclared(init, node, parent, ctx);
  }
  return undefined;
}

function declareEnumConstant(node: Node, ctx: Ctx): undefined {
  const nameNode = node.childForFieldName('name');
  const parent = nameNode ? containerOf(node, ctx) : undefined;
  if (!nameNode || parent?.kind !== 'enum') return undefined;
  const init: SymbolInit = {
    kind: 'enum_member',
    name: nodeText(ctx.source, nameNode),
    syntax: node,
    visibility: 'public',
    isStatic: true,
    isExported: parent.isExported,
  };
  const doc = javadocOf(node, ctx.source);
  if (doc) init.docstring = doc;
  const symbol = ctx.b.addSymbol(init, parent);
  for (const a of annotationsOf(node)) addAnnotation(a, symbol, ctx);
  return undefined;
}

function visitImport(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const name = node.namedChildren.find((c) => c?.type === 'scoped_identifier' || c?.type === 'identifier');
  if (!name) return undefined;
  const spec = compact(nodeText(source, name));
  const star = node.namedChildren.some((c) => c?.type === 'asterisk');
  const meta: RefMetadata = {};
  if (node.children.some((c) => c?.type === 'static')) meta.static = true;
  if (star) meta.star = true;
  else meta.binding = spec.slice(spec.lastIndexOf('.') + 1);
  b.addSymbol(
    { kind: 'import', name: star ? `${spec}.*` : spec, syntax: node, signature: headerText(source, node) },
    b.file,
  );
  b.addRef(b.file.id, spec, 'imports', node, meta);
  return undefined;
}

function visitCall(node: Node, ctx: Ctx): undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const object = node.childForFieldName('object');
  const receiver = object ? receiverName(object, ctx.source) : undefined;
  const name = nodeText(ctx.source, nameNode);
  ctx.b.addRef(ctx.b.scopeAt(node).node.id, receiver ? `${receiver}.${name}` : name, 'calls', node);
  return undefined;
}

function visitNew(node: Node, ctx: Ctx): undefined {
  const type = node.childForFieldName('type');
  const name = type ? typeName(type, ctx.source) : undefined;
  if (name) ctx.b.addRef(ctx.b.scopeAt(node).node.id, name, 'instantiates', node);
  return undefined;
}

function baseInit(kind: NodeKind, name: string, node: Node, parent: GraphNode, ctx: Ctx): SymbolInit {
  const visibility =
    VISIBILITIES.find((v) => hasModifier(node, v)) ?? (parent.kind === 'interface' ? 'public' : 'package');
  const init: SymbolInit = {
    kind,
    name,
    syntax: node,
    visibility,
    isExported: visibility === 'public',
  };
  if (hasModifier(node, 'static')) init.isStatic = true;
  if (hasModifier(node, 'abstract')) init.isAbstract = true;
  const decorators = annotationsOf(node).flatMap((a) => {
    const n = annotationName(a, ctx.source);
    return n ? [n] : [];
  });
  if (decorators.length > 0) init.decorators = decorators;
  const doc = javadocOf(node, ctx.source);
  if (doc) init.docstring = doc;
  return init;
}

function addDeclared(init: SymbolInit, node: Node, parent: GraphNode, ctx: Ctx): GraphNode {
  const symbol = ctx.b.addSymbol(init, parent);
  ctx.owners.set(node.id, symbol);
  for (const a of annotationsOf(node)) addAnnotation(a, symbol, ctx);
  return symbol;
}

function addAnnotation(annotation: Node, symbol: GraphNode, ctx: Ctx): void {
  const name = annotationName(annotation, ctx.source);
  if (name) ctx.b.addRef(symbol.id, name, 'decorates', annotation);
}

function addTypeRef(type: Node | null, symbol: GraphNode, kind: 'extends' | 'implements', ctx: Ctx): void {
  const name = type ? typeName(type, ctx.source) : undefined;
  if (type && name) ctx.b.addRef(symbol.id, name, kind, type);
}

/**
 * The symbol a declaration is directly inside: the owning type for members, the package (or the
 * file) for top-level types. Undefined for anything nested in a method body, initializer,
 * anonymous class or enum-constant body. ERROR nodes are transparent.
 */
function containerOf(node: Node, ctx: Ctx): GraphNode | undefined {
  let container = node.parent;
  while (container) {
    if (container.type === 'program') return ctx.namespace ?? ctx.b.file;
    if (TYPE_BODIES.has(container.type)) {
      const holder = container.parent;
      return holder ? ctx.owners.get(holder.id) : undefined;
    }
    if (container.type === 'enum_body_declarations' || container.type === 'ERROR') {
      container = container.parent;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function isTypeSymbol(symbol: GraphNode): boolean {
  return symbol.kind === 'class' || symbol.kind === 'interface' || symbol.kind === 'enum';
}

function modifiersOf(node: Node): Node | undefined {
  return node.namedChildren.find((c) => c?.type === 'modifiers') ?? undefined;
}

function hasModifier(node: Node, keyword: string): boolean {
  return modifiersOf(node)?.children.some((c) => c?.type === keyword) ?? false;
}

function annotationsOf(node: Node): Node[] {
  return (modifiersOf(node)?.namedChildren ?? []).filter(
    (c): c is Node => c?.type === 'marker_annotation' || c?.type === 'annotation',
  );
}

function annotationName(annotation: Node, source: string): string | undefined {
  const name = annotation.childForFieldName('name');
  return name ? compact(nodeText(source, name)) : undefined;
}

/** Start of the declaration header without leading annotations. */
function headerStart(node: Node): number {
  for (const child of modifiersOf(node)?.children ?? []) {
    if (child && child.type !== 'marker_annotation' && child.type !== 'annotation') return child.startIndex;
  }
  const afterModifiers = node.children.find((c) => c && c.type !== 'modifiers');
  return afterModifiers?.startIndex ?? node.startIndex;
}

/** `foo`, `this`, `a.b.c`; undefined for a computed receiver (`a().b`), leaving just the method name. */
function receiverName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'identifier':
    case 'this':
    case 'super':
      return nodeText(source, node);
    case 'field_access': {
      const field = node.childForFieldName('field');
      const object = node.childForFieldName('object');
      const receiver = object ? receiverName(object, source) : undefined;
      return field && receiver ? `${receiver}.${nodeText(source, field)}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Type reference without generic arguments: `List<String>` → `List`, `a.b.C` → `a.b.C`. */
function typeName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'type_identifier':
    case 'scoped_type_identifier':
      return compact(nodeText(source, node)).replace(/<.*>/s, '');
    case 'generic_type': {
      const inner = node.namedChildren.find(
        (c) => c?.type === 'type_identifier' || c?.type === 'scoped_type_identifier',
      );
      return inner ? typeName(inner, source) : undefined;
    }
    default:
      return undefined;
  }
}

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

function javadocOf(node: Node, source: string): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev?.type !== 'block_comment' || prev.endPosition.row < node.startPosition.row - 1) return undefined;
  const text = nodeText(source, prev);
  if (!text.startsWith('/**')) return undefined;
  const doc = text
    .slice(3, -2)
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').trim())
    .join('\n')
    .trim();
  return doc || undefined;
}
