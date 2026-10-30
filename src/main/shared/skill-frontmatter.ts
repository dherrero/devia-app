/**
 * Minimal YAML frontmatter parser tailored to SKILL.md files.
 *
 * Lives in `src/main/shared/` because it's a pure utility consumed by
 * multiple features (skills, skill-registry, …). The line-based scanner
 * stays intentionally permissive: skills with malformed frontmatter still
 * surface (with the directory name as a fallback) so the user can see
 * them and remove or fix them.
 *
 * Only the fields we actually consume are extracted (`name`,
 * `description`, `metadata.internal`). The upstream Agent Skills spec
 * doesn't define any nested-array fields we'd parse here.
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  internal?: boolean;
}

const FRONT_RE = /^---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;

export function parseSkillFrontmatter(source: string): SkillFrontmatter {
  const m = FRONT_RE.exec(source);
  if (!m || !m[1]) return {};
  const block = m[1];

  const out: SkillFrontmatter = {};
  // Tracks the current nesting key (`metadata:`) so we can pick up
  // `  internal: true` indented underneath without a real YAML stack.
  let section: string | null = null;

  for (const rawLine of block.split(/\r?\n/)) {
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.match(/^\s*/)?.[0].length ?? 0;
    const line = rawLine.trim();

    if (indent === 0 && /^[A-Za-z_][\w-]*:\s*$/.test(line)) {
      section = line.slice(0, -1).trim();
      continue;
    }
    if (indent === 0) section = null;

    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv || !kv[1]) continue;
    const key = kv[1];
    const value = stripQuotes((kv[2] ?? '').trim());

    if (indent === 0) {
      if (key === 'name') out.name = value;
      else if (key === 'description') out.description = value;
    } else if (section === 'metadata' && key === 'internal') {
      out.internal = value === 'true' || value === 'yes' || value === '1';
    }
  }

  return out;
}

function stripQuotes(s: string): string {
  if (s.length >= 2) {
    const first = s.charCodeAt(0);
    const last = s.charCodeAt(s.length - 1);
    if ((first === 34 && last === 34) || (first === 39 && last === 39)) {
      return s.slice(1, -1);
    }
  }
  return s;
}
