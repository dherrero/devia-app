import type { Node, Tree } from 'web-tree-sitter';
import type {
  CodeGraphLanguage,
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
  type Scope,
  type SymbolInit,
} from '../extractor';

// Adapted from codegraph (MIT), src/extraction/languages/typescript.ts and javascript.ts.

const DECLARATION_KINDS: Readonly<Record<string, NodeKind>> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  enum_declaration: 'enum',
  type_alias_declaration: 'type_alias',
  internal_module: 'namespace',
  module: 'namespace',
  method_definition: 'method',
  method_signature: 'method',
  abstract_method_signature: 'method',
  public_field_definition: 'property',
  field_definition: 'property',
  property_signature: 'property',
};

const SCOPE_KINDS: ReadonlySet<NodeKind> = new Set([
  'class',
  'interface',
  'enum',
  'namespace',
  'function',
  'method',
  'component',
]);

const FUNCTION_VALUES: ReadonlySet<string> = new Set([
  'arrow_function',
  'function_expression',
  'function',
  'generator_function',
]);

const JSX_NODES: ReadonlySet<string> = new Set([
  'jsx_element',
  'jsx_self_closing_element',
  'jsx_fragment',
]);

type Handler = (node: Node, ctx: Ctx) => boolean | void;

const HANDLERS: Readonly<Record<string, Handler>> = {
  ...Object.fromEntries(
    Object.entries(DECLARATION_KINDS).map(([type, kind]) => [type, (n: Node, ctx: Ctx) => declare(n, kind, ctx)]),
  ),
  import_statement: visitImport,
  export_statement: visitExport,
  lexical_declaration: visitVariables,
  variable_declaration: visitVariables,
  call_expression: visitCall,
  new_expression: visitNew,
  jsx_opening_element: visitJsx,
  jsx_self_closing_element: visitJsx,
  decorator: () => false,
};

interface Ctx {
  source: string;
  b: ExtractionBuilder;
  exportedLocals: Map<string, boolean>;
}

function createExtractor(language: CodeGraphLanguage, extensions: string[]): LanguageExtractor {
  return {
    language,
    extensions,
    extract(relPath: string, source: string, tree: Tree): FileExtraction {
      const b = new ExtractionBuilder(relPath, language, tree.rootNode);
      const ctx: Ctx = { source, b, exportedLocals: new Map() };
      try {
        walk(tree.rootNode, (node) => {
          b.noteSyntaxError(node);
          return HANDLERS[node.type]?.(node, ctx);
        });
        markExportedLocals(ctx);
      } catch (err) {
        b.addError(`extraction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      return b.result;
    },
  };
}

export const typescriptExtractor = createExtractor('typescript', ['.ts', '.tsx', '.mts', '.cts']);
export const javascriptExtractor = createExtractor('javascript', ['.js', '.jsx', '.mjs', '.cjs']);

function declare(node: Node, kind: NodeKind, ctx: Ctx): boolean {
  const { b, source } = ctx;
  const wrapper = statementOf(node);
  const exportDefault = isExportDefault(wrapper);
  const nameNode = node.childForFieldName('name') ?? node.childForFieldName('property');
  const name = nameNode ? unquote(nodeText(source, nameNode)) : exportDefault ? 'default' : undefined;
  if (!name) return true;

  const fnValue = kind === 'property' ? functionValueOf(node) : undefined;
  if (fnValue) kind = 'method';
  const body = fnValue ? fnValue.childForFieldName('body') : node.childForFieldName('body');
  if (kind === 'function' && isComponent(name, body)) kind = 'component';

  const init: SymbolInit = {
    kind,
    name,
    syntax: node,
    signature: headerText(source, node, body, afterDecorators(node)),
    isExported: wrapper.type === 'export_statement',
  };
  addModifiers(init, node, nameNode, fnValue);
  addDocAndDecorators(init, node, wrapper, ctx);
  if (exportDefault) init.metadata = { exportDefault: true };

  const symbol = b.addSymbol(init, b.scopeAt(node));
  for (const decorator of init.decorators ?? []) b.addRef(symbol.id, decorator, 'decorates', node);
  if (SCOPE_KINDS.has(kind)) b.enterScope(node, symbol);
  if (kind === 'class') addHeritage(node, symbol, ctx);
  if (kind === 'interface') addInterfaceExtends(node, symbol, ctx);
  if (kind === 'enum' && body) addEnumMembers(body, ctx);
  return true;
}

function visitVariables(node: Node, ctx: Ctx): boolean {
  const { b, source } = ctx;
  const scope = b.scopeAt(node);
  if (scope.node.kind !== 'file' && scope.node.kind !== 'namespace') return true;
  const wrapper = statementOf(node);
  const isConst = node.children.some((c) => c?.type === 'const');
  for (const declarator of node.namedChildren) {
    if (declarator?.type !== 'variable_declarator') continue;
    const nameNode = declarator.childForFieldName('name');
    if (nameNode?.type !== 'identifier') continue;
    const value = declarator.childForFieldName('value');
    if (value && requireSpecifier(value, source) !== undefined) continue;
    const name = nodeText(source, nameNode);
    const fn = value && FUNCTION_VALUES.has(value.type) ? value : undefined;
    const body = fn?.childForFieldName('body');
    const kind: NodeKind = fn
      ? isComponent(name, body) ? 'component' : 'function'
      : isConst ? 'constant' : 'variable';
    const init: SymbolInit = {
      kind,
      name,
      syntax: declarator,
      signature: headerText(source, declarator, body),
      isExported: wrapper.type === 'export_statement',
    };
    if (fn && hasToken(fn, 'async')) init.isAsync = true;
    const doc = jsDocOf(wrapper, source);
    if (doc) init.docstring = doc;
    const symbol = b.addSymbol(init, scope);
    if (fn) b.enterScope(declarator, symbol);
  }
  return true;
}

function visitImport(node: Node, ctx: Ctx): boolean {
  const { b, source } = ctx;
  const sourceNode = node.childForFieldName('source');
  const requireClause = node.namedChildren.find((c) => c?.type === 'import_require_clause');
  const specNode = sourceNode ?? requireClause?.childForFieldName('source');
  if (!specNode) return false;
  const spec = unquote(nodeText(source, specNode));
  addImportNode(spec, node, ctx);

  const typeOnly = hasToken(node, 'type');
  const emit = (meta: RefMetadata, at: Node): void => {
    b.addRef(b.file.id, spec, 'imports', at, typeOnly ? { ...meta, typeOnly: true } : meta);
  };

  if (requireClause) {
    const local = requireClause.namedChildren.find((c) => c?.type === 'identifier');
    if (local) emit({ binding: nodeText(source, local), imported: '*', star: true }, local);
    return false;
  }
  const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
  if (!clause) {
    emit({ sideEffect: true }, specNode);
    return false;
  }
  for (const part of clause.namedChildren) {
    if (!part) continue;
    if (part.type === 'identifier') {
      emit({ binding: nodeText(source, part), imported: 'default' }, part);
    } else if (part.type === 'namespace_import') {
      const local = part.namedChildren.find((c) => c?.type === 'identifier');
      if (local) emit({ binding: nodeText(source, local), imported: '*', star: true }, part);
    } else if (part.type === 'named_imports') {
      for (const spec of part.namedChildren) {
        if (spec?.type !== 'import_specifier') continue;
        const meta = specifierMetadata(spec, ctx);
        if (hasToken(spec, 'type')) meta['typeOnly'] = true;
        emit(meta, spec);
      }
    }
  }
  return false;
}

function specifierMetadata(spec: Node, ctx: Ctx): RefMetadata {
  const imported = nodeText(ctx.source, spec.childForFieldName('name') ?? spec);
  const alias = spec.childForFieldName('alias');
  if (!alias) return { binding: imported, imported };
  const local = nodeText(ctx.source, alias);
  return { binding: local, imported, alias: local };
}

function visitExport(node: Node, ctx: Ctx): boolean {
  const { b, source } = ctx;
  if (node.childForFieldName('declaration')) return true;
  const sourceNode = node.childForFieldName('source');
  const spec = sourceNode ? unquote(nodeText(source, sourceNode)) : undefined;

  const value = node.childForFieldName('value');
  if (value) {
    if (value.type === 'identifier') ctx.exportedLocals.set(nodeText(source, value), true);
    else if (FUNCTION_VALUES.has(value.type)) declare(value, 'function', ctx);
    else if (value.type === 'class') declare(value, 'class', ctx);
    return true;
  }

  const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
  if (!clause) {
    if (!spec || !sourceNode) return false;
    const nsExport = node.namedChildren.find((c) => c?.type === 'namespace_export');
    const exported = nsExport?.namedChildren.find((c) => c !== null && c.type !== '*');
    const meta: RefMetadata = { imported: '*', star: true, reexport: true };
    if (exported) meta['exported'] = unquote(nodeText(source, exported));
    b.addRef(b.file.id, spec, 'imports', sourceNode, meta);
    addExportNode(exported ? unquote(nodeText(source, exported)) : '*', node, { source: spec }, ctx);
    return false;
  }

  for (const specifier of clause.namedChildren) {
    if (specifier?.type !== 'export_specifier') continue;
    const local = nodeText(source, specifier.childForFieldName('name') ?? specifier);
    const alias = specifier.childForFieldName('alias');
    const exported = alias ? nodeText(source, alias) : local;
    if (spec) {
      b.addRef(b.file.id, spec, 'imports', specifier, { imported: local, exported, reexport: true });
      addExportNode(exported, specifier, { source: spec, imported: local }, ctx);
    } else {
      ctx.exportedLocals.set(local, exported === 'default');
      addExportNode(exported, specifier, { local }, ctx);
    }
  }
  return false;
}

function visitCall(node: Node, ctx: Ctx): boolean {
  const { b, source } = ctx;
  const callee = node.childForFieldName('function');
  if (!callee || callee.type === 'super') return true;

  const required = requireSpecifier(node, source);
  if (required !== undefined) {
    addCommonJsImport(node, required, ctx);
    return true;
  }
  if (callee.type === 'import') {
    const arg = firstStringArgument(node);
    if (arg) {
      const spec = unquote(nodeText(source, arg));
      addImportNode(spec, node, ctx);
      b.addRef(b.file.id, spec, 'imports', node, { dynamic: true });
    }
    return true;
  }
  const name = calleeName(callee, source);
  if (name) b.addRef(b.scopeAt(node).node.id, name, 'calls', node);
  return true;
}

function visitNew(node: Node, ctx: Ctx): boolean {
  const ctor = node.childForFieldName('constructor');
  const name = ctor ? calleeName(ctor, ctx.source) : undefined;
  if (name) ctx.b.addRef(ctx.b.scopeAt(node).node.id, name, 'instantiates', node);
  return true;
}

function visitJsx(node: Node, ctx: Ctx): boolean {
  const tag = node.childForFieldName('name');
  if (!tag) return true;
  const name = calleeName(tag, ctx.source);
  if (name && /^[A-Z]/.test(name)) ctx.b.addRef(ctx.b.scopeAt(node).node.id, name, 'references', node);
  return true;
}

function addCommonJsImport(call: Node, spec: string, ctx: Ctx): void {
  const { b, source } = ctx;
  addImportNode(spec, call, ctx);
  const declarator = call.parent?.type === 'variable_declarator' ? call.parent : undefined;
  const pattern = declarator?.childForFieldName('name');
  if (pattern?.type === 'identifier') {
    const binding = nodeText(source, pattern);
    b.addRef(b.file.id, spec, 'imports', call, { binding, imported: '*', star: true, commonjs: true });
    return;
  }
  if (pattern?.type === 'object_pattern') {
    for (const prop of pattern.namedChildren) {
      if (prop?.type === 'shorthand_property_identifier_pattern') {
        const binding = nodeText(source, prop);
        b.addRef(b.file.id, spec, 'imports', prop, { binding, imported: binding, commonjs: true });
      } else if (prop?.type === 'pair_pattern') {
        const key = prop.childForFieldName('key');
        const value = prop.childForFieldName('value');
        if (key && value?.type === 'identifier') {
          const binding = nodeText(source, value);
          const imported = unquote(nodeText(source, key));
          b.addRef(b.file.id, spec, 'imports', prop, { binding, imported, alias: binding, commonjs: true });
        }
      }
    }
    return;
  }
  b.addRef(b.file.id, spec, 'imports', call, { sideEffect: true, commonjs: true });
}

function addImportNode(spec: string, at: Node, ctx: Ctx): void {
  const signature = headerText(ctx.source, statementOf(at));
  ctx.b.addSymbol({ kind: 'import', name: spec, syntax: at, signature }, fileScope(ctx));
}

function addExportNode(name: string, at: Node, metadata: RefMetadata, ctx: Ctx): void {
  ctx.b.addSymbol({ kind: 'export', name, syntax: at, isExported: true, metadata }, fileScope(ctx));
}

function fileScope(ctx: Ctx): Scope {
  return { node: ctx.b.file, endIndex: Number.POSITIVE_INFINITY };
}

function markExportedLocals(ctx: Ctx): void {
  if (ctx.exportedLocals.size === 0) return;
  for (const node of ctx.b.result.nodes) {
    if (node.kind === 'file' || node.kind === 'import' || node.kind === 'export') continue;
    const isDefault = ctx.exportedLocals.get(node.qualifiedName);
    if (isDefault === undefined) continue;
    node.isExported = true;
    if (isDefault) node.metadata = { ...node.metadata, exportDefault: true };
  }
}

function addHeritage(node: Node, symbol: GraphNode, ctx: Ctx): void {
  const heritage = node.namedChildren.find((c) => c?.type === 'class_heritage');
  if (!heritage) return;
  for (const part of heritage.namedChildren) {
    if (!part) continue;
    if (part.type === 'extends_clause') {
      for (const value of part.childrenForFieldName('value')) addTypeRef(value, symbol, 'extends', ctx);
    } else if (part.type === 'implements_clause') {
      for (const type of part.namedChildren) addTypeRef(type, symbol, 'implements', ctx);
    } else {
      addTypeRef(part, symbol, 'extends', ctx);
    }
  }
}

function addInterfaceExtends(node: Node, symbol: GraphNode, ctx: Ctx): void {
  const clause = node.namedChildren.find((c) => c?.type === 'extends_type_clause');
  for (const type of clause?.namedChildren ?? []) addTypeRef(type, symbol, 'extends', ctx);
}

function addTypeRef(type: Node | null, symbol: GraphNode, kind: 'extends' | 'implements', ctx: Ctx): void {
  if (!type) return;
  const named = type.type === 'generic_type' ? type.childForFieldName('name') : type;
  const name = named ? (calleeName(named, ctx.source) ?? nodeText(ctx.source, named)) : undefined;
  if (name) ctx.b.addRef(symbol.id, name, kind, type);
}

function addEnumMembers(body: Node, ctx: Ctx): void {
  const scope = ctx.b.scopeAt(body);
  for (const member of body.namedChildren) {
    if (!member) continue;
    const nameNode = member.type === 'enum_assignment' ? member.childForFieldName('name') : member;
    if (!nameNode || (member.type !== 'enum_assignment' && member.type !== 'property_identifier')) continue;
    const name = unquote(nodeText(ctx.source, nameNode));
    ctx.b.addSymbol({ kind: 'enum_member', name, syntax: member, signature: headerText(ctx.source, member) }, scope);
  }
}

function addModifiers(init: SymbolInit, node: Node, nameNode: Node | null, fnValue: Node | undefined): void {
  const accessibility = node.namedChildren.find((c) => c?.type === 'accessibility_modifier');
  const visibility = accessibility?.text;
  if (visibility === 'public' || visibility === 'protected' || visibility === 'private') {
    init.visibility = visibility;
  } else if (nameNode?.type === 'private_property_identifier') {
    init.visibility = 'private';
  }
  if (hasToken(node, 'static')) init.isStatic = true;
  if (hasToken(node, 'async') || (fnValue && hasToken(fnValue, 'async'))) init.isAsync = true;
  if (node.type.startsWith('abstract_') || hasToken(node, 'abstract')) init.isAbstract = true;
}

function addDocAndDecorators(init: SymbolInit, node: Node, wrapper: Node, ctx: Ctx): void {
  const decorators: Node[] = [];
  for (let prev = node.previousNamedSibling; prev?.type === 'decorator'; prev = prev.previousNamedSibling) {
    decorators.unshift(prev);
  }
  for (const holder of wrapper === node ? [node] : [wrapper, node]) {
    for (const child of holder.childrenForFieldName('decorator')) {
      if (child && !decorators.some((d) => d.id === child.id)) decorators.push(child);
    }
  }
  const names = decorators.flatMap((d) => {
    const target = d.namedChild(0);
    const expr = target?.type === 'call_expression' ? target.childForFieldName('function') : target;
    const name = expr ? calleeName(expr, ctx.source) : undefined;
    return name ? [name] : [];
  });
  if (names.length > 0) init.decorators = names;
  const doc = jsDocOf(decorators[0] && decorators[0].startIndex < wrapper.startIndex ? decorators[0] : wrapper, ctx.source);
  if (doc) init.docstring = doc;
}

/** The node whose siblings hold the doc comment and whose parent carries `export`. */
function statementOf(node: Node): Node {
  let current = node;
  const parent = current.parent;
  if (parent && (parent.type === 'expression_statement' || parent.type === 'ambient_declaration')) {
    current = parent;
  }
  if (current.parent?.type === 'export_statement') current = current.parent;
  return current;
}

function afterDecorators(node: Node): number {
  let start = node.startIndex;
  for (const d of node.childrenForFieldName('decorator')) if (d) start = Math.max(start, d.endIndex);
  return start;
}

function isExportDefault(wrapper: Node): boolean {
  return wrapper.type === 'export_statement' && hasToken(wrapper, 'default');
}

function jsDocOf(node: Node, source: string): string | undefined {
  const prev = node.previousNamedSibling;
  if (prev?.type !== 'comment' || prev.endPosition.row < node.startPosition.row - 1) return undefined;
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

function functionValueOf(field: Node): Node | undefined {
  const value = field.childForFieldName('value');
  if (!value) return undefined;
  if (FUNCTION_VALUES.has(value.type)) return value;
  if (value.type === 'call_expression') {
    const args = value.childForFieldName('arguments');
    return args?.namedChildren.find((a) => a !== null && FUNCTION_VALUES.has(a.type)) ?? undefined;
  }
  return undefined;
}

function isComponent(name: string, body: Node | null | undefined): boolean {
  if (!body || !/^[A-Z]/.test(name)) return false;
  let found = JSX_NODES.has(body.type);
  if (!found) {
    walk(body, (n) => {
      if (found) return false;
      if (JSX_NODES.has(n.type)) found = true;
      return !found;
    });
  }
  return found;
}

/** `foo`, `this.bar`, `a.b.c`; for a computed receiver (`a().b`) just the member name. */
function calleeName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
    case 'private_property_identifier':
    case 'jsx_identifier':
    case 'this':
    case 'super':
      return nodeText(source, node);
    case 'nested_identifier':
    case 'nested_type_identifier':
      return nodeText(source, node).replace(/\s+/g, '');
    case 'member_expression': {
      const property = node.childForFieldName('property');
      if (!property) return undefined;
      const prop = nodeText(source, property);
      const object = node.childForFieldName('object');
      const receiver = object ? calleeName(object, source) : undefined;
      return receiver ? `${receiver}.${prop}` : prop;
    }
    default:
      return undefined;
  }
}

function requireSpecifier(node: Node, source: string): string | undefined {
  if (node.type !== 'call_expression') return undefined;
  const callee = node.childForFieldName('function');
  if (callee?.type !== 'identifier' || nodeText(source, callee) !== 'require') return undefined;
  const arg = firstStringArgument(node);
  return arg ? unquote(nodeText(source, arg)) : undefined;
}

function firstStringArgument(call: Node): Node | undefined {
  const arg = call.childForFieldName('arguments')?.namedChild(0);
  if (arg?.type === 'string') return arg;
  if (arg?.type === 'template_string' && !arg.namedChildren.some((c) => c?.type === 'template_substitution')) {
    return arg;
  }
  return undefined;
}

function hasToken(node: Node, token: string): boolean {
  return node.children.some((c) => c?.type === token);
}
