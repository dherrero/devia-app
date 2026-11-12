// Receiver type facts (S-44 T-515): the language-neutral vocabulary extractors use to tell the
// resolver what type a receiver has, so `recv.m()` can reach the method when `recv` is a field,
// a local, a parameter or a call result. Facts are plain strings in node/ref metadata, so they
// persist with the nodes and refs of their file and are rewritten whenever that file is
// re-extracted (a full index and a sync produce the same facts).
//
// WHERE a fact lives:
// - node `type`: the declared (or initializer) type of a value node: field, property, variable.
// - node `returns`: the declared return type of a function or method.
// - node `typeParams`: the generic parameter names of a class/interface/function (`T,K`), so a
//   bare `T` is never looked up as a project type and `Repo<Order>` can bind `T` to `Order`.
// - generic declaration `tb:<T>`: the single upper bound of type parameter `T`
//   (`<T extends Identified>`); an unbound `T` receiver is then at least an `Identified`.
// - class-like node `ft:<field>`: the type of a field that has no node of its own (a TS
//   constructor parameter property, a Python `self.x = …` assignment).
// - ref `headType`: the type of the reference name's FIRST segment, a local or parameter
//   (`log.info` with `const log = new Logger()`). `?` means "a local/parameter whose type is
//   unknown": the resolver then stays silent instead of resolving the name to an outer symbol.
// - ref `ownerType`: the type that owns the WHOLE reference name, for calls on a computed
//   receiver (`this.repo.get(id).markPaid()` → name `markPaid`, ownerType `=this.repo.get()`).
//
// A fact is a TypeExpr:
// - a type: `Name`, `ns.Name`, `Name<Arg, Arg>`: resolved as a type name seen from the node
//   that holds the fact (imports and lexical scope of that node's file);
// - a value chain, prefixed by `=`: `=head.seg.seg()`, where `head` is `this`, a name visible
//   from the holder (`getRepo()`, an imported constant) or `{Type}`, and a trailing `()` takes
//   the declared return type of the member/function. Extractors expand locals themselves, so a
//   chain never starts with a local or parameter name.
// Anything an extractor cannot express (unions, arrays, literals, inferred returns) is simply not
// recorded: no fact means no inferred edge.

export const FACT_TYPE = 'type';
export const FACT_RETURNS = 'returns';
export const FACT_TYPE_PARAMS = 'typeParams';
export const FIELD_FACT_PREFIX = 'ft:';
export const BOUND_FACT_PREFIX = 'tb:';
export const REF_HEAD_TYPE = 'headType';
export const REF_OWNER_TYPE = 'ownerType';
export const UNKNOWN_TYPE = '?';

export interface ParsedType {
  name: string;
  args: string[];
}

export interface ChainSegment {
  name: string;
  call: boolean;
}

export interface ParsedChain {
  /** `{Type}` heads carry the type; otherwise `name` is `this`, `self` or a visible name. */
  head: ChainSegment & { type?: string };
  segs: ChainSegment[];
}

export function isChain(expr: string): boolean {
  return expr.startsWith('=');
}

/** `Name` + generic arguments, or undefined when a part is not expressible. */
export function typeExpr(name: string, args: (string | undefined)[] = []): string | undefined {
  if (!name) return undefined;
  if (args.length === 0) return name;
  // An argument we cannot express still keeps its slot, so later arguments bind the right parameter.
  return `${name}<${args.map((a) => a ?? UNKNOWN_TYPE).join(',')}>`;
}

/** Appends `.seg` / `.seg()` to a receiver fact; a plain type becomes a `{Type}` head. */
export function extendChain(base: string, seg: string, call: boolean): string {
  const head = isChain(base) ? base : `={${base}}`;
  return `${head}.${seg}${call ? '()' : ''}`;
}

/** Splits at top-level occurrences of `sep` (outside `<>` and `{}`). */
function splitTop(text: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '<' || c === '{') depth++;
    else if (c === '>' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

export function parseType(expr: string): ParsedType | undefined {
  const text = expr.trim();
  const lt = text.indexOf('<');
  if (lt < 0) return text && text !== UNKNOWN_TYPE ? { name: text, args: [] } : undefined;
  if (!text.endsWith('>')) return undefined;
  const name = text.slice(0, lt);
  const inner = text.slice(lt + 1, -1);
  return name ? { name, args: inner ? splitTop(inner, ',').map((a) => a.trim()) : [] } : undefined;
}

export function parseChain(expr: string): ParsedChain | undefined {
  if (!isChain(expr)) return undefined;
  const parts = splitTop(expr.slice(1), '.');
  const segs: ChainSegment[] = [];
  for (const part of parts) {
    const call = part.endsWith('()');
    const name = call ? part.slice(0, -2) : part;
    if (!name) return undefined;
    segs.push({ name, call });
  }
  const [head, ...rest] = segs;
  if (!head) return undefined;
  if (head.name.startsWith('{') && head.name.endsWith('}'))
    return { head: { name: '', call: head.call, type: head.name.slice(1, -1) }, segs: rest };
  return { head, segs: rest };
}
