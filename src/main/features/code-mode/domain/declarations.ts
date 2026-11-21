import type { CatalogTool } from './tool-catalog';

/** Server and tool names become identifiers in the script's `tools` object. */
export function toIdentifier(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_]/g, '_');
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned || '_';
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function literal(v: unknown): string {
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v === null) return 'null';
  return 'unknown';
}

/** A deliberately small JSON Schema → TypeScript mapper: anything it does not
 *  understand becomes `unknown`, which still lets the script compile. */
function schemaToTs(schema: unknown, depth = 0): string {
  if (!isRecord(schema) || depth > 6) return 'unknown';
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    return schema['enum'].map(literal).join(' | ');
  }
  const type = schema['type'];
  if (Array.isArray(type)) {
    const parts = type.filter((t): t is string => typeof t === 'string').map((t) => schemaToTs({ ...schema, type: t }, depth + 1));
    return parts.length > 0 ? parts.join(' | ') : 'unknown';
  }
  switch (type) {
    case 'string':
      return 'string';
    case 'number':
    case 'integer':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'null':
      return 'null';
    case 'array':
      return `${wrap(schemaToTs(schema['items'], depth + 1))}[]`;
    case 'object':
      return objectToTs(schema, depth);
    default:
      return isRecord(schema['properties']) ? objectToTs(schema, depth) : 'unknown';
  }
}

function wrap(ts: string): string {
  return /[|&]/.test(ts) ? `(${ts})` : ts;
}

function objectToTs(schema: Record<string, unknown>, depth: number): string {
  const props = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].filter((r): r is string => typeof r === 'string') : []);
  const fields = Object.entries(props).map(([key, value]) => {
    const name = IDENT.test(key) ? key : `'${key.replace(/'/g, "\\'")}'`;
    return `${name}${required.has(key) ? '' : '?'}: ${schemaToTs(value, depth + 1)}`;
  });
  if (fields.length === 0) return schema['additionalProperties'] === false ? '{}' : 'Record<string, unknown>';
  return `{ ${fields.join('; ')} }`;
}

/**
 * The ambient declaration the script is type-checked against, and the text
 * `get_types` returns to the agent:
 *
 *     declare const tools: { tiendas: { listar(args: { region: string }): Promise<any>; }; };
 */
export function generateDeclarations(tools: readonly CatalogTool[]): string {
  const byServer = new Map<string, CatalogTool[]>();
  for (const t of tools) {
    const list = byServer.get(t.server) ?? [];
    list.push(t);
    byServer.set(t.server, list);
  }
  const lines: string[] = ['declare const tools: {'];
  for (const [server, list] of byServer) {
    lines.push(`  ${toIdentifier(server)}: {`);
    for (const t of list) {
      if (t.description) lines.push(`    /** ${t.description.replace(/\*\//g, '* /').replace(/\s+/g, ' ').trim()} */`);
      // Most MCP servers declare no outputSchema. `unknown` would make every such
      // result unusable without a cast, so the shape is `any`: the agent learns it
      // by returning a small sample from a first script.
      const result = t.outputSchema === undefined ? 'any' : schemaToTs(t.outputSchema);
      lines.push(`    ${toIdentifier(t.name)}(args: ${schemaToTs(t.inputSchema)}): Promise<${result}>;`);
    }
    lines.push('  };');
  }
  lines.push('};');
  return lines.join('\n');
}
