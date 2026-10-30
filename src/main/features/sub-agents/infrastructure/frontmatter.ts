/**
 * Sub-agent Markdown frontmatter parser + renderer (#275).
 *
 * Wider than the skill parser (`src/main/shared/skill-frontmatter.ts`)
 * because sub-agents carry arrays (`tools`), numbers (`maxTurns`)
 * and a boolean (`readonly`). Inputs come from agent-native files
 * (Claude, Cursor, Gemini) as well as Devia's own
 * `.devia/sub-agents/<name>.md`, so the parser tolerates both the
 * comma-separated string form Claude uses for `tools` and the YAML
 * array form Cursor + Gemini accept.
 *
 * No external YAML dependency — the surface we accept is small.
 */

export interface SubAgentFrontmatter {
  name?: string;
  description?: string;
  /** Tools as a normalised array. The raw can be either
   *  `tools: Read, Write` (Claude) or `tools: [Read, Write]` (Cursor). */
  tools?: string[];
  model?: string;
  maxTurns?: number;
  readonly?: boolean;
  /** Devia-managed marker (used by the writer to recognise its own
   *  files on re-sync). Missing → user/imported file. */
  devia_managed?: boolean;
  /** Devia source-of-truth field: which CLIs this sub-agent should
   *  materialise into. Optional in the on-disk file. */
  agents?: string[];
}

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export interface ParsedSubAgentFile {
  readonly frontmatter: SubAgentFrontmatter;
  /** Body after the second `---` line. */
  readonly body: string;
}

export function parseSubAgentFile(raw: string): ParsedSubAgentFile {
  const m = FRONT_RE.exec(raw);
  if (!m || !m[1]) return { frontmatter: {}, body: raw };
  const fm = parseFrontmatterBlock(m[1]);
  const body = raw.slice(m[0].length).replace(/^\r?\n/, '');
  return { frontmatter: fm, body };
}

export function renderSubAgentFile(
  fm: SubAgentFrontmatter,
  body: string,
): string {
  const lines: string[] = ['---'];
  if (fm.name) lines.push(`name: ${quoteIfNeeded(fm.name)}`);
  if (fm.description) lines.push(`description: ${quoteIfNeeded(fm.description)}`);
  if (fm.tools && fm.tools.length > 0) lines.push(`tools: ${fm.tools.join(', ')}`);
  if (fm.model) lines.push(`model: ${quoteIfNeeded(fm.model)}`);
  if (typeof fm.maxTurns === 'number') lines.push(`maxTurns: ${fm.maxTurns}`);
  if (fm.readonly === true) lines.push('readonly: true');
  if (fm.devia_managed) lines.push('devia_managed: true');
  if (fm.agents && fm.agents.length > 0) {
    lines.push(`agents: [${fm.agents.join(', ')}]`);
  }
  lines.push('---');
  lines.push('');
  return lines.join('\n') + body.replace(/^\n+/, '');
}

// ─── internals ────────────────────────────────────────────────────

function parseFrontmatterBlock(block: string): SubAgentFrontmatter {
  const out: SubAgentFrontmatter = {};
  for (const rawLine of block.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const eq = line.indexOf(':');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const valueRaw = line.slice(eq + 1).trim();
    if (!key) continue;

    switch (key) {
      case 'name':
      case 'description':
      case 'model':
        (out as Record<string, unknown>)[key] = unquote(valueRaw);
        break;
      case 'tools':
        out.tools = parseList(valueRaw);
        break;
      case 'agents':
        out.agents = parseList(valueRaw);
        break;
      case 'maxTurns': {
        const n = Number(unquote(valueRaw));
        if (Number.isFinite(n)) out.maxTurns = n;
        break;
      }
      case 'readonly':
        out.readonly = unquote(valueRaw).toLowerCase() === 'true';
        break;
      case 'devia_managed':
        out.devia_managed = unquote(valueRaw).toLowerCase() === 'true';
        break;
      default:
        // Tolerate unknown keys so external author intent doesn't
        // get clobbered on round-trip — but we drop them when
        // re-rendering (renderSubAgentFile only knows our schema).
        break;
    }
  }
  return out;
}

/**
 * Accepts both `Read, Write` and `[Read, Write]`. Returns the
 * trimmed token list; empty input → []. Unquoted, simple.
 */
function parseList(raw: string): string[] {
  if (!raw) return [];
  const stripped = raw.startsWith('[') && raw.endsWith(']')
    ? raw.slice(1, -1)
    : raw;
  return stripped
    .split(',')
    .map((t) => unquote(t.trim()))
    .filter((t) => t.length > 0);
}

function unquote(s: string): string {
  if (s.length >= 2) {
    const first = s.charCodeAt(0);
    const last = s.charCodeAt(s.length - 1);
    if ((first === 34 && last === 34) || (first === 39 && last === 39)) {
      return s.slice(1, -1);
    }
  }
  return s;
}

function quoteIfNeeded(value: string): string {
  if (value.length === 0) return '""';
  // Quote when the value contains characters YAML would interpret —
  // colons, square brackets, leading/trailing whitespace, etc.
  if (/[:[\]{}#&*!|>'"%@`,]/.test(value) || /^\s|\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}
