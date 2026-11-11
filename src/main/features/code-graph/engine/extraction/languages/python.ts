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
  walk,
  type FileExtraction,
  type LanguageExtractor,
  type SymbolInit,
} from '../extractor';

// Adapted from codegraph (MIT), src/extraction/languages/python.ts.
//
// Only function and class bodies introduce scope in Python. `if`/`try`/`for`/`while`/`with`
// do not, so (unlike the TypeScript extractor, where blocks are scopes) declarations inside them
// at module or class level ARE module/class symbols (`if TYPE_CHECKING:`, `if __name__ == ...`).
// - module level: classes, functions, `NAME = ...` variables/constants;
// - class bodies: methods and nested classes;
// - the direct body of a function: nested def/class (`outer.inner`), never variables;
// - anything else (declarations in a block inside a function, lambdas, comprehensions): nothing.
// Calls inside skipped code still hang off the enclosing symbol or the file.

const TRANSPARENT: ReadonlySet<string> = new Set([
  'if_statement',
  'elif_clause',
  'else_clause',
  'try_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'for_statement',
  'while_statement',
  'with_statement',
  'match_statement',
  'case_clause',
  'ERROR',
]);

const MAX_DOCSTRING = 1000;

interface Ctx {
  source: string;
  b: ExtractionBuilder;
  module: GraphNode;
  exportsAll: ReadonlySet<string> | undefined;
  /** Syntax node id → the symbol it declares. */
  owners: Map<number, GraphNode>;
}

export const pythonExtractor: LanguageExtractor = {
  language: 'python',
  extensions: ['.py', '.pyi'],
  extract(relPath: string, source: string, tree: Tree): FileExtraction {
    const b = new ExtractionBuilder(relPath, 'python', tree.rootNode);
    const module = b.addSymbol(
      { kind: 'module', name: modulePath(relPath), syntax: tree.rootNode },
      b.file,
    );
    const ctx: Ctx = {
      source,
      b,
      module,
      exportsAll: readAll(tree.rootNode, source),
      owners: new Map(),
    };
    ctx.owners.set(tree.rootNode.id, module);
    const doc = docstringOf(tree.rootNode, source);
    if (doc) module.docstring = doc;
    try {
      walk(tree.rootNode, (node) => {
        b.noteSyntaxError(node);
        switch (node.type) {
          case 'function_definition':
            return declare(node, ctx, 'function');
          case 'class_definition':
            return declare(node, ctx, 'class');
          case 'assignment':
            return visitAssignment(node, ctx);
          case 'import_statement':
            return visitImport(node, ctx);
          case 'import_from_statement':
            return visitFrom(node, ctx);
          case 'call':
            return visitCall(node, ctx);
          case 'decorator':
            return false;
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

function modulePath(relPath: string): string {
  const parts = relPath.replace(/\.pyi?$/, '').split('/');
  if (parts[parts.length - 1] === '__init__' && parts.length > 1) parts.pop();
  return parts.join('.');
}

function declare(
  node: Node,
  ctx: Ctx,
  kind: 'function' | 'class',
): boolean | undefined {
  const { b, source } = ctx;
  const nameNode = node.childForFieldName('name');
  const parent = nameNode ? parentSymbol(node, ctx, true) : undefined;
  if (!nameNode || !parent) return undefined;
  const name = nodeText(source, nameNode);
  const body = node.childForFieldName('body');
  const decorators = decoratorsOf(node);
  const decoratorNames = decorators.flatMap((d) => {
    const name = decoratorName(d, source);
    return name ? [name] : [];
  });

  const symbolKind: NodeKind =
    kind === 'function' && parent.kind === 'class' ? 'method' : kind;
  const init: SymbolInit = {
    kind: symbolKind,
    name,
    syntax: node,
    signature: headerText(source, node, body),
    visibility: visibilityOf(name),
    isExported: parent === ctx.module && isExportedName(name, ctx),
  };
  if (kind === 'function' && node.children.some((c) => c?.type === 'async'))
    init.isAsync = true;
  if (decoratorNames.includes('staticmethod')) init.isStatic = true;
  if (
    decoratorNames.some(
      (d) => d === 'abstractmethod' || d.endsWith('.abstractmethod'),
    )
  )
    init.isAbstract = true;
  if (decoratorNames.length > 0) init.decorators = decoratorNames;
  const doc = body ? docstringOf(body, source) : undefined;
  if (doc) init.docstring = doc;

  const symbol = b.addSymbol(init, parent);
  ctx.owners.set(node.id, symbol);
  for (const d of decorators) {
    const target = decoratorTarget(d);
    const text = decoratorName(d, source);
    if (target && text) b.addRef(symbol.id, text, 'decorates', d);
  }
  b.enterScope(node, symbol);
  if (kind === 'class') addBases(node, symbol, ctx);
  return undefined;
}

function visitAssignment(node: Node, ctx: Ctx): undefined {
  const { b, source } = ctx;
  const statement = node.parent;
  const left = node.childForFieldName('left');
  if (statement?.type !== 'expression_statement' || left?.type !== 'identifier')
    return undefined;
  if (parentSymbol(statement, ctx, false) !== ctx.module) return undefined;
  const name = nodeText(source, left);
  const right = node.childForFieldName('right');
  const isLambda = right?.type === 'lambda';
  const kind: NodeKind = isLambda
    ? 'function'
    : /^[A-Z][A-Z0-9_]*$/.test(name)
      ? 'constant'
      : 'variable';
  const init: SymbolInit = {
    kind,
    name,
    syntax: node,
    signature: headerText(
      source,
      node,
      isLambda ? right.childForFieldName('body') : undefined,
    ),
    visibility: visibilityOf(name),
    isExported: isExportedName(name, ctx),
  };
  const symbol = b.addSymbol(init, ctx.module);
  if (isLambda) b.enterScope(node, symbol);
  return undefined;
}

function visitImport(node: Node, ctx: Ctx): undefined {
  const { source } = ctx;
  for (const part of node.childrenForFieldName('name')) {
    if (!part) continue;
    const dotted =
      part.type === 'aliased_import' ? part.childForFieldName('name') : part;
    if (!dotted) continue;
    const spec = nodeText(source, dotted).replace(/\s+/g, '');
    const alias =
      part.type === 'aliased_import' ? part.childForFieldName('alias') : null;
    const meta: RefMetadata = alias
      ? { binding: nodeText(source, alias), alias: nodeText(source, alias) }
      : { binding: spec.split('.')[0] ?? spec };
    addImport(spec, node, part, meta, ctx);
  }
  return undefined;
}

function visitFrom(node: Node, ctx: Ctx): undefined {
  const { source } = ctx;
  const moduleNode = node.childForFieldName('module_name');
  if (!moduleNode) return undefined;
  const spec = nodeText(source, moduleNode).replace(/\s+/g, '');
  let any = false;
  for (const part of node.childrenForFieldName('name')) {
    if (!part) continue;
    const imported =
      part.type === 'aliased_import' ? part.childForFieldName('name') : part;
    if (!imported) continue;
    const importedName = nodeText(source, imported);
    const alias =
      part.type === 'aliased_import' ? part.childForFieldName('alias') : null;
    const meta: RefMetadata = alias
      ? {
          binding: nodeText(source, alias),
          imported: importedName,
          alias: nodeText(source, alias),
        }
      : { binding: importedName, imported: importedName };
    addImport(spec, node, part, meta, ctx);
    any = true;
  }
  if (node.namedChildren.some((c) => c?.type === 'wildcard_import')) {
    addImport(spec, node, node, { imported: '*', star: true }, ctx);
    any = true;
  }
  if (!any) addImport(spec, node, node, { sideEffect: true }, ctx);
  return undefined;
}

function addImport(
  spec: string,
  statement: Node,
  at: Node,
  meta: RefMetadata,
  ctx: Ctx,
): void {
  const { b, source } = ctx;
  if (parentSymbol(statement, ctx, false) === ctx.module) {
    b.addSymbol(
      {
        kind: 'import',
        name: spec,
        syntax: statement,
        signature: headerText(source, statement),
      },
      ctx.module,
    );
    // A module-level `from x import y [as z]` makes `z` importable from this module (the
    // package __init__ re-export idiom), so it is stored like a TS re-export for the resolver.
    const imported = meta['imported'];
    if (typeof imported === 'string') {
      const star = imported === '*';
      const name = star ? '*' : String(meta['binding'] ?? imported);
      b.addSymbol(
        {
          kind: 'export',
          name,
          syntax: at,
          isExported: true,
          metadata: star ? { source: spec } : { source: spec, imported },
        },
        ctx.module,
      );
    }
  }
  b.addRef(b.file.id, spec, 'imports', at, meta);
}

function visitCall(node: Node, ctx: Ctx): undefined {
  const callee = node.childForFieldName('function');
  const name = callee ? calleeName(callee, ctx.source) : undefined;
  if (name) ctx.b.addRef(ctx.b.scopeAt(node).node.id, name, 'calls', node);
  return undefined;
}

function addBases(node: Node, symbol: GraphNode, ctx: Ctx): void {
  const supers = node.childForFieldName('superclasses');
  for (const arg of supers?.namedChildren ?? []) {
    if (!arg || arg.type === 'keyword_argument' || arg.type === 'comment')
      continue;
    const target =
      arg.type === 'subscript' ? arg.childForFieldName('value') : arg;
    const name = target ? calleeName(target, ctx.source) : undefined;
    if (name) ctx.b.addRef(symbol.id, name, 'extends', arg);
  }
}

/** The symbol a declaration belongs to, or undefined when it must not become a symbol (see header). */
function parentSymbol(
  node: Node,
  ctx: Ctx,
  allowInFunctionBody: boolean,
): GraphNode | undefined {
  const statement =
    node.parent?.type === 'decorated_definition' ? node.parent : node;
  let container = statement.parent;
  let direct = true;
  while (container) {
    if (container.type === 'module') return ctx.module;
    if (container.type === 'block') {
      const holder = container.parent;
      if (holder?.type === 'function_definition') {
        return direct && allowInFunctionBody
          ? ctx.owners.get(holder.id)
          : undefined;
      }
      if (holder?.type === 'class_definition')
        return allowInFunctionBody ? ctx.owners.get(holder.id) : undefined;
      direct = false;
      container = holder;
    } else if (TRANSPARENT.has(container.type)) {
      direct = false;
      container = container.parent;
    } else {
      return undefined;
    }
  }
  return undefined;
}

function decoratorsOf(node: Node): Node[] {
  if (node.parent?.type !== 'decorated_definition') return [];
  return node.parent.namedChildren.filter(
    (c): c is Node => c?.type === 'decorator',
  );
}

function decoratorTarget(decorator: Node): Node | undefined {
  const expr = decorator.namedChild(0) ?? undefined;
  return expr?.type === 'call'
    ? (expr.childForFieldName('function') ?? undefined)
    : expr;
}

function decoratorName(decorator: Node, source: string): string | undefined {
  const target = decoratorTarget(decorator);
  return target ? calleeName(target, source) : undefined;
}

/** `foo`, `self.bar`, `a.b.c`; for a computed receiver (`a().b`) just the attribute name. */
function calleeName(node: Node, source: string): string | undefined {
  switch (node.type) {
    case 'identifier':
      return nodeText(source, node);
    case 'attribute': {
      const attr = node.childForFieldName('attribute');
      if (!attr) return undefined;
      const object = node.childForFieldName('object');
      const receiver = object ? calleeName(object, source) : undefined;
      return receiver
        ? `${receiver}.${nodeText(source, attr)}`
        : nodeText(source, attr);
    }
    default:
      return undefined;
  }
}

function visibilityOf(name: string): 'public' | 'private' {
  if (name.startsWith('__') && name.endsWith('__') && name.length > 4)
    return 'public';
  return name.startsWith('_') ? 'private' : 'public';
}

function isExportedName(name: string, ctx: Ctx): boolean {
  return ctx.exportsAll ? ctx.exportsAll.has(name) : !name.startsWith('_');
}

function readAll(root: Node, source: string): ReadonlySet<string> | undefined {
  let found: Set<string> | undefined;
  for (const stmt of root.namedChildren) {
    const assign =
      stmt?.type === 'expression_statement' ? stmt.namedChild(0) : null;
    if (
      assign?.type !== 'assignment' &&
      assign?.type !== 'augmented_assignment'
    )
      continue;
    const left = assign.childForFieldName('left');
    const right = assign.childForFieldName('right');
    if (!left || nodeText(source, left) !== '__all__') continue;
    if (right?.type !== 'list' && right?.type !== 'tuple') continue;
    found ??= new Set();
    for (const item of right.namedChildren) {
      if (item?.type === 'string')
        found.add(stringValue(nodeText(source, item)));
    }
  }
  return found;
}

function stringValue(text: string): string {
  const match = /^[a-zA-Z]*("""|'''|"|')([\s\S]*)\1$/.exec(text);
  return match?.[2] ?? text;
}

/** First string expression statement of a module or block. */
function docstringOf(container: Node, source: string): string | undefined {
  const first = container.namedChildren.find((c) => c && c.type !== 'comment');
  const expr =
    first?.type === 'expression_statement' ? first.namedChild(0) : null;
  if (expr?.type !== 'string') return undefined;
  const doc = stringValue(nodeText(source, expr))
    .trim()
    .slice(0, MAX_DOCSTRING);
  return doc || undefined;
}
