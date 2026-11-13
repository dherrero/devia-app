// Adapted from codegraph (MIT) — see NOTICE
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
import { FACT_RETURNS, FACT_TYPE } from '../type-facts';
import { DartLocals, genericFacts, typeFact } from './dart-types';

// Upstream codegraph: src/extraction/languages/dart.ts.
//
// The vendored grammar is flat: a function's signature and its `function_body` are siblings, a
// call is an `identifier` followed by `selector` siblings, and top-level variables are loose
// siblings of `program`. Annotations of members and functions are preceding siblings; those of a
// class are its children. Symbols: types, their members and top-level declarations. Locals,
// closures and local functions are never symbols; their calls hang off the enclosing member.

const TYPE_NODES: ReadonlySet<string> = new Set([
  'class_definition',
  'mixin_declaration',
  'extension_declaration',
  'enum_declaration',
]);

const BODIES: ReadonlySet<string> = new Set([
  'class_body',
  'extension_body',
  'enum_body',
]);

const CONSTRUCTORS: ReadonlySet<string> = new Set([
  'constructor_signature',
  'constant_constructor_signature',
  'factory_constructor_signature',
  'redirecting_factory_constructor_signature',
]);

const SIGNATURES: ReadonlySet<string> = new Set([
  'function_signature',
  'getter_signature',
  'setter_signature',
  ...CONSTRUCTORS,
]);

const VARIABLE_LISTS: ReadonlySet<string> = new Set([
  'initialized_identifier_list',
  'static_final_declaration_list',
]);

/** Tokens and nodes that can precede a variable list within one declaration. */
const DECLARATION_HEADER: ReadonlySet<string> = new Set([
  'const_builtin',
  'final_builtin',
  'inferred_type',
  'type_identifier',
  'type_arguments',
  'function_type',
  'record_type',
  'void_type',
  'nullable_type',
  '?',
  '.',
  'static',
  'late',
  'external',
  'covariant',
]);

const WIDGET_BASES: ReadonlySet<string> = new Set([
  'StatelessWidget',
  'StatefulWidget',
  'State',
  'InheritedWidget',
]);

interface Ctx {
  source: string;
  b: ExtractionBuilder;
  /** Syntax node id → the symbol it declares (types, signature holders and their bodies). */
  owners: Map<number, GraphNode>;
  /** Locals and parameters in scope, for receiver type facts (dart-types.ts). */
  locals: DartLocals;
}

export const dartExtractor: LanguageExtractor = {
  language: 'dart',
  extensions: ['.dart'],
  extract(relPath: string, source: string, tree: Tree): FileExtraction {
    const b = new ExtractionBuilder(relPath, 'dart', tree.rootNode);
    const ctx: Ctx = { source, b, owners: new Map(), locals: new DartLocals(source) };
    try {
      walk(tree.rootNode, (node) => {
        b.noteSyntaxError(node);
        ctx.locals.declareBindings(node);
        const type = node.type;
        if (TYPE_NODES.has(type)) return declareType(node, ctx);
        if (type === 'method_signature' || type === 'declaration')
          return declareMember(node, ctx);
        if (
          type === 'function_signature' ||
          type === 'getter_signature' ||
          type === 'setter_signature'
        ) {
          if (isTopLevel(node)) declareCallable(node, node, ctx);
          return undefined;
        }
        if (VARIABLE_LISTS.has(type)) return declareVariables(node, ctx);
        switch (type) {
          case 'enum_constant':
            return declareEnumConstant(node, ctx);
          case 'type_alias':
            return declareTypeAlias(node, ctx);
          case 'library_import':
            return visitImport(node, ctx);
          case 'library_export':
            return visitExport(node, ctx);
          case 'part_directive':
          case 'part_of_directive':
            return visitPart(node, ctx);
          case 'selector':
            return visitSelector(node, ctx);
          case 'cascade_section':
            return visitCascade(node, ctx);
          case 'new_expression':
          case 'const_object_expression':
            return visitNew(node, ctx);
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

function declareType(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const parent = containerOf(node, ctx);
  if (!parent) return undefined;
  const directTypes = typeRefs(node.children);
  const name = node.children.find((c) => c?.type === 'identifier');
  let symbolName = name ? nodeText(source, name) : undefined;
  if (!symbolName && node.type === 'extension_declaration') {
    const on = directTypes[0];
    if (on) symbolName = `extension on ${on.name}`;
  }
  if (!symbolName) return undefined;

  const isAbstract = node.children.some((c) => c?.type === 'abstract');
  const dartKind =
    node.type === 'extension_declaration'
      ? 'extension'
      : isAbstract
        ? 'abstract'
        : node.type === 'mixin_declaration' ||
            node.children.some((c) => c?.type === 'mixin')
          ? 'mixin'
          : 'class';
  const superclass = node.children.find((c) => c?.type === 'superclass');
  const superTypes = typeRefs(superclass?.children ?? []);
  const widget =
    node.type === 'class_definition' &&
    superTypes[0] !== undefined &&
    WIDGET_BASES.has(
      superTypes[0].name.slice(superTypes[0].name.lastIndexOf('.') + 1),
    );

  const kind: NodeKind =
    node.type === 'enum_declaration' ? 'enum' : widget ? 'component' : 'class';
  const metadata: RefMetadata = genericFacts(node, source);
  if (kind !== 'enum') metadata['dartKind'] = dartKind;
  if (widget) metadata['widget'] = true;

  const body = node.children.find((c) => c && BODIES.has(c.type));
  const init = baseInit(kind, symbolName, node, node, ctx);
  init.signature = headerText(source, node, body, headerStart(node));
  if (Object.keys(metadata).length > 0) init.metadata = metadata;
  if (isAbstract) init.isAbstract = true;
  const symbol = b.addSymbol(init, parent);
  ctx.owners.set(node.id, symbol);
  addAnnotations(node, symbol, ctx);

  const superRef = superTypes[0];
  if (superRef) b.addRef(symbol.id, superRef.name, 'extends', superRef.node);
  const mixins = superclass?.children.find((c) => c?.type === 'mixins');
  for (const t of typeRefs(mixins?.children ?? []))
    b.addRef(symbol.id, t.name, 'implements', t.node, { via: 'mixin' });
  for (const child of node.children) {
    if (child?.type === 'mixins') {
      for (const t of typeRefs(child.children))
        b.addRef(symbol.id, t.name, 'implements', t.node, { via: 'mixin' });
    } else if (child?.type === 'interfaces') {
      for (const t of typeRefs(child.children))
        b.addRef(symbol.id, t.name, 'implements', t.node);
    }
  }
  if (
    node.type === 'mixin_declaration' ||
    node.type === 'extension_declaration'
  ) {
    for (const t of directTypes)
      b.addRef(symbol.id, t.name, 'extends', t.node, { via: 'on' });
  }
  return undefined;
}

function declareMember(holder: Node, ctx: Ctx): undefined {
  const sig = holder.children.find((c) => c && SIGNATURES.has(c.type));
  if (!sig || !BODIES.has(holder.parent?.type ?? '')) return undefined;
  declareCallable(sig, holder, ctx);
  return undefined;
}

/** `holder` is the node followed by the body (and preceded by annotations and docs). */
function declareCallable(sig: Node, holder: Node, ctx: Ctx): void {
  const { b, source } = ctx;
  const parent = containerOf(holder, ctx);
  if (!parent) return;
  const topLevel = parent === b.file || !isTypeKind(parent);
  const isCtor = CONSTRUCTORS.has(sig.type);
  const ids = sig.children
    .filter((c) => c?.type === 'identifier')
    .map((c) => nodeText(source, c as Node));
  if (ids.length === 0) return;

  let kind: NodeKind;
  let name: string;
  const metadata: RefMetadata = {};
  if (isCtor) {
    kind = 'method';
    name = ids.slice(0, 2).join('.');
    metadata['constructor'] = true;
    if (
      sig.type === 'factory_constructor_signature' ||
      sig.type === 'redirecting_factory_constructor_signature'
    ) {
      metadata['factory'] = true;
    }
  } else {
    name = ids[0] as string;
    if (sig.type === 'getter_signature' || sig.type === 'setter_signature') {
      kind = 'property';
      metadata['accessor'] = sig.type === 'getter_signature' ? 'get' : 'set';
    } else {
      kind = topLevel ? 'function' : 'method';
    }
  }

  const body = nextBody(holder);
  const init = baseInit(kind, name, holder, holder, ctx);
  if (
    isCtor ? name.split('.').pop()?.startsWith('_') && ids.length > 1 : false
  ) {
    init.visibility = 'private';
    init.isExported = false;
  }
  init.signature = headerText(source, holder);
  if (!isCtor) {
    Object.assign(metadata, genericFacts(sig, source));
    const declared = sig.type === 'setter_signature' ? undefined : typeFact(sig.children, source);
    if (declared) metadata[kind === 'property' ? FACT_TYPE : FACT_RETURNS] = declared;
  }
  if (Object.keys(metadata).length > 0) init.metadata = metadata;
  if (holder.children.some((c) => c?.type === 'static')) init.isStatic = true;
  if (!body && !isCtor && holder.type === 'declaration') init.isAbstract = true;
  if (
    body?.children.some(
      (c) => c?.type === 'async' || c?.type === 'async*' || c?.type === 'sync*',
    )
  ) {
    init.isAsync = true;
  }
  const symbol = b.addSymbol(init, parent);
  ctx.owners.set(holder.id, symbol);
  if (body) {
    ctx.owners.set(body.id, symbol);
    symbol.endLine = body.endPosition.row + 1;
  }
  addAnnotations(holder, symbol, ctx);
}

function declareVariables(list: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const owner = list.parent;
  if (!owner) return undefined;
  const topLevel = owner.type === 'program' || owner.type === 'ERROR';
  const isField =
    owner.type === 'declaration' && BODIES.has(owner.parent?.type ?? '');
  if (!topLevel && !isField) return undefined;
  const parent = containerOf(isField ? owner : list, ctx);
  if (!parent) return undefined;

  const header: Node[] = [];
  for (
    let p = list.previousSibling;
    p && DECLARATION_HEADER.has(p.type);
    p = p.previousSibling
  )
    header.unshift(p);
  const first = header[0] ?? list;
  const isConst = header.some(
    (h) => h.type === 'const_builtin' || h.type === 'final_builtin',
  );
  const kind: NodeKind = isField ? 'field' : isConst ? 'constant' : 'variable';
  const anchor = isField ? owner : first;
  const signature = headerText(
    source,
    list,
    null,
    (isField ? owner : first).startIndex,
  );

  const declared = typeFact(header, source);
  for (const entry of list.children) {
    const id = entry?.children.find((c) => c?.type === 'identifier');
    if (!entry || !id) continue;
    const init = baseInit(kind, nodeText(source, id), entry, anchor, ctx);
    init.signature = signature;
    const type = declared ?? ctx.locals.chainFact(entry.namedChildren.filter((c) => c?.id !== id.id));
    if (type) init.metadata = { [FACT_TYPE]: type };
    if (header.some((h) => h.type === 'static')) init.isStatic = true;
    const symbol = b.addSymbol(init, parent);
    addAnnotations(anchor, symbol, ctx);
  }
  return undefined;
}

function declareEnumConstant(node: Node, ctx: Ctx): undefined {
  const id = node.children.find((c) => c?.type === 'identifier');
  const parent = containerOf(node, ctx);
  if (!id || parent?.kind !== 'enum') return undefined;
  const init = baseInit(
    'enum_member',
    nodeText(ctx.source, id),
    node,
    node,
    ctx,
  );
  init.isStatic = true;
  ctx.b.addSymbol(init, parent);
  return undefined;
}

function declareTypeAlias(node: Node, ctx: Ctx): undefined {
  const parent = containerOf(node, ctx);
  if (!parent) return undefined;
  let name: Node | undefined;
  for (const child of node.children) {
    if (
      !child ||
      child.type === '=' ||
      child.type === 'type_parameters' ||
      child.type === 'formal_parameter_list'
    )
      break;
    if (child.type === 'type_identifier') name = child;
  }
  if (!name) return undefined;
  const init = baseInit(
    'type_alias',
    nodeText(ctx.source, name),
    node,
    node,
    ctx,
  );
  init.signature = headerText(ctx.source, node);
  const symbol = ctx.b.addSymbol(init, parent);
  addAnnotations(node, symbol, ctx);
  return undefined;
}

function nonEmpty(meta: RefMetadata): RefMetadata | undefined {
  return Object.keys(meta).length > 0 ? meta : undefined;
}

function uriOf(
  node: Node,
  source: string,
): { text: string; at: Node } | undefined {
  const uri = findDescendant(node, 'uri');
  if (!uri) return undefined;
  return { text: unquote(nodeText(source, uri).trim()), at: uri };
}

function combinators(node: Node, source: string): RefMetadata {
  const meta: RefMetadata = {};
  for (const c of node.children) {
    if (c?.type !== 'combinator') continue;
    const keyword = c.children[0]?.type;
    if (keyword !== 'show' && keyword !== 'hide') continue;
    const ids = c.children
      .filter((x) => x?.type === 'identifier')
      .map((x) => nodeText(source, x as Node));
    const prior = typeof meta[keyword] === 'string' ? `${meta[keyword]},` : '';
    meta[keyword] = prior + ids.join(',');
  }
  return meta;
}

function visitImport(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const spec =
    node.children.find((c) => c?.type === 'import_specification') ?? node;
  const uri = uriOf(spec, source);
  if (!uri) return undefined;
  const meta: RefMetadata = {};
  const aliasAt = spec.children.findIndex((c) => c?.type === 'as');
  const alias = aliasAt >= 0 ? spec.children[aliasAt + 1] : undefined;
  if (alias) {
    meta['alias'] = nodeText(source, alias);
    meta['binding'] = nodeText(source, alias);
  }
  Object.assign(meta, combinators(spec, source));
  if (spec.children.some((c) => c?.type === 'deferred'))
    meta['deferred'] = true;
  b.addSymbol(
    {
      kind: 'import',
      name: uri.text,
      syntax: node,
      signature: headerText(source, node),
    },
    b.file,
  );
  b.addRef(b.file.id, uri.text, 'imports', node, nonEmpty(meta));
  return undefined;
}

function visitExport(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const uri = uriOf(node, source);
  if (!uri) return undefined;
  const meta = combinators(node, source);
  b.addSymbol(
    {
      kind: 'export',
      name: uri.text,
      syntax: node,
      signature: headerText(source, node),
    },
    b.file,
  );
  b.addRef(b.file.id, uri.text, 'exports', node, nonEmpty(meta));
  return undefined;
}

function visitPart(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const uri = uriOf(node, source);
  const text =
    uri?.text ??
    node.children
      .filter(
        (c) => c?.type === 'identifier' || c?.type === 'dotted_identifier_list',
      )
      .map((c) => nodeText(source, c as Node))
      .join('');
  if (!text) return undefined;
  b.addRef(b.file.id, text, 'imports', node, { part: true });
  return undefined;
}

function visitSelector(node: Node, ctx: Ctx): undefined {
  if (!node.children.some((c) => c?.type === 'argument_part')) return undefined;
  const callee = calleeName(node, ctx.source);
  if (callee) addCallOrNew(callee, node, ctx, ctx.locals.callMetadata(node));
  return undefined;
}

function visitCascade(node: Node, ctx: Ctx): undefined {
  if (!node.children.some((c) => c?.type === 'argument_part')) return undefined;
  const selector = node.children.find((c) => c?.type === 'cascade_selector');
  if (!selector) return undefined;
  ctx.b.addRef(
    ownerOf(node, ctx).id,
    nodeText(ctx.source, selector),
    'calls',
    selector,
    ctx.locals.cascadeMetadata(node),
  );
  return undefined;
}

function visitNew(node: Node, ctx: Ctx): undefined {
  const parts: string[] = [];
  for (const c of node.children) {
    if (!c || c.type === 'arguments') break;
    if (c.type === 'type_identifier' || c.type === 'identifier')
      parts.push(nodeText(ctx.source, c));
  }
  if (parts.length > 0)
    ctx.b.addRef(ownerOf(node, ctx).id, parts.join('.'), 'instantiates', node);
  return undefined;
}

const UPPER = /^[_$]*[A-Z]/;

/** `Foo()`, `Foo.named()`, `prefix.Foo()` look like constructor calls; everything else is a call. */
function addCallOrNew(callee: string, at: Node, ctx: Ctx, meta: RefMetadata | undefined): void {
  const segs = callee.split('.');
  const last = segs[segs.length - 1] ?? '';
  const prev = segs[segs.length - 2];
  const ctor = UPPER.test(last) || (prev !== undefined && UPPER.test(prev));
  ctx.b.addRef(
    ownerOf(at, ctx).id,
    callee,
    ctor ? 'instantiates' : 'calls',
    at,
    meta,
  );
}

function simpleSelectorName(
  selector: Node,
  source: string,
): string | undefined {
  if (selector.type !== 'selector') return undefined;
  const inner = selector.children[0];
  if (
    inner?.type !== 'unconditional_assignable_selector' &&
    inner?.type !== 'conditional_assignable_selector'
  ) {
    return undefined;
  }
  const rest = inner.children.filter(
    (c) => c && c.type !== '.' && c.type !== '?.',
  );
  const id = rest[0];
  return rest.length === 1 && id?.type === 'identifier'
    ? nodeText(source, id)
    : undefined;
}

/** `foo`, `this.bar`, `a.b.c`; a computed receiver (`a().b()`) leaves just the method name. */
function calleeName(call: Node, source: string): string | undefined {
  const names: string[] = [];
  let p = call.previousSibling;
  while (p) {
    const n = simpleSelectorName(p, source);
    if (n === undefined) break;
    names.unshift(n);
    p = p.previousSibling;
  }
  const isHead =
    p && (p.type === 'identifier' || p.type === 'this' || p.type === 'super');
  if (names.length === 0) return isHead && p ? nodeText(source, p) : undefined;
  if (!isHead || !p) return names[names.length - 1];
  return `${nodeText(source, p)}.${names.join('.')}`;
}

function baseInit(
  kind: NodeKind,
  name: string,
  syntax: Node,
  anchor: Node,
  ctx: Ctx,
): SymbolInit {
  const isPrivate = name.split('.').pop()?.startsWith('_') ?? false;
  const init: SymbolInit = {
    kind,
    name,
    syntax,
    visibility: isPrivate ? 'private' : 'public',
    isExported: !isPrivate,
  };
  const { docstring, annotations } = leading(anchor, ctx);
  if (docstring) init.docstring = docstring;
  const own = annotationNodes(anchor).concat(annotations);
  const decorators = own.flatMap((a) => {
    const n = annotationName(a, ctx.source);
    return n ? [n] : [];
  });
  if (decorators.length > 0) init.decorators = decorators;
  return init;
}

function annotationNodes(node: Node): Node[] {
  return node.children.filter((c): c is Node => c?.type === 'annotation');
}

function addAnnotations(anchor: Node, symbol: GraphNode, ctx: Ctx): void {
  const all = [...leading(anchor, ctx).annotations, ...annotationNodes(anchor)];
  for (const a of all) {
    const name = annotationName(a, ctx.source);
    if (name) ctx.b.addRef(symbol.id, name, 'decorates', a);
  }
}

/** Annotations (in source order) and the contiguous `///` block directly before `anchor`. */
function leading(
  anchor: Node,
  ctx: Ctx,
): { docstring: string | undefined; annotations: Node[] } {
  const annotations: Node[] = [];
  const docs: Node[] = [];
  let next = anchor;
  for (let p = anchor.previousSibling; p; p = p.previousSibling) {
    if (p.type !== 'annotation' && p.type !== 'documentation_comment') break;
    if (p.endPosition.row < next.startPosition.row - 1) break;
    if (p.type === 'annotation') {
      if (docs.length > 0) break;
      annotations.unshift(p);
    } else docs.unshift(p);
    next = p;
  }
  const text = docs
    .map((d) =>
      nodeText(ctx.source, d)
        .replace(/^\s*\/\*\*/, '')
        .replace(/\*\/\s*$/, '')
        .split('\n')
        .map((l) => l.replace(/^\s*(\/\/\/|\*)\s?/, '').trim())
        .join('\n'),
    )
    .join('\n')
    .trim();
  return { docstring: text || undefined, annotations };
}

function annotationName(annotation: Node, source: string): string | undefined {
  let name = '';
  for (const c of annotation.children) {
    if (!c || c.type === 'arguments' || c.type === 'type_arguments') break;
    if (
      c.type === 'identifier' ||
      c.type === 'type_identifier' ||
      c.type === '.'
    )
      name += nodeText(source, c);
  }
  return name || undefined;
}

/** Start of a type declaration's header without its leading annotations. */
function headerStart(node: Node): number {
  const first = node.children.find((c) => c && c.type !== 'annotation');
  return first?.startIndex ?? node.startIndex;
}

function nextBody(holder: Node): Node | undefined {
  let n = holder.nextSibling;
  while (n && (n.type === 'comment' || n.type === 'documentation_comment'))
    n = n.nextSibling;
  return n?.type === 'function_body' ? n : undefined;
}

function isTopLevel(node: Node): boolean {
  const t = node.parent?.type;
  return t === 'program' || t === 'ERROR';
}

function isTypeKind(symbol: GraphNode): boolean {
  return (
    symbol.kind === 'class' ||
    symbol.kind === 'component' ||
    symbol.kind === 'enum'
  );
}

/** The symbol a declaration is directly inside: the owning type for members, the file at top level. */
function containerOf(node: Node, ctx: Ctx): GraphNode | undefined {
  let container = node.parent;
  while (container) {
    if (
      container.type === 'program' ||
      (container.type === 'ERROR' && !container.parent)
    )
      return ctx.b.file;
    if (BODIES.has(container.type)) {
      const holder = container.parent;
      return holder ? ctx.owners.get(holder.id) : undefined;
    }
    if (container.type === 'ERROR') {
      container = container.parent;
      continue;
    }
    return undefined;
  }
  return undefined;
}

function ownerOf(node: Node, ctx: Ctx): GraphNode {
  for (let p: Node | null = node; p; p = p.parent) {
    const owner = ctx.owners.get(p.id);
    if (owner) return owner;
  }
  return ctx.b.file;
}

interface TypeRef {
  name: string;
  node: Node;
}

/** Type names among `children`, generics dropped and `prefix.Name` kept: `m.Foo<X>` → `m.Foo`. */
function typeRefs(children: (Node | null)[]): TypeRef[] {
  const refs: TypeRef[] = [];
  let afterDot = false;
  for (const c of children) {
    if (!c) continue;
    if (c.type === 'type_identifier') {
      const last = refs[refs.length - 1];
      if (afterDot && last) last.name += `.${c.text}`;
      else refs.push({ name: c.text, node: c });
      afterDot = false;
    } else if (c.type === '.') afterDot = true;
    else if (c.type !== 'type_arguments') afterDot = false;
  }
  return refs;
}

function findDescendant(node: Node, type: string): Node | undefined {
  let found: Node | undefined;
  walk(node, (n) => {
    if (found) return false;
    if (n.type === type) {
      found = n;
      return false;
    }
    return undefined;
  });
  return found;
}
