import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSubAgentFile } from '../../sub-agents/infrastructure/frontmatter';

/**
 * The sub-agents Devia manages (`<project>/.devia/sub-agents/<name>.md`, the
 * sub-agent manager's source of truth), served through `devia_skill` to ANY
 * agent (S-30 T-356). A CLI without native sub-agents can still take on one's
 * role; a CLI with them also gets them natively from its mapper.
 *
 * Read inside the MCP server process, straight off disk, with the same guards
 * as skills — `name` comes from a language model.
 */

const SAFE_NAME = /^[A-Za-z0-9_.-]+$/;
export const MAX_SUBAGENT_BYTES = 64 * 1024;

export interface SubagentSummary {
  name: string;
  description: string;
}

interface Definition extends SubagentSummary {
  tools: readonly string[];
  model?: string;
  body: string;
}

/**
 * Enabled definitions only. The sub-agent manager writes `agents:` only when it
 * is non-empty, so a missing (or empty) list means the user parked it.
 */
function readAll(dir: string): Definition[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const root = path.resolve(dir);
  const out: Definition[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
    const stem = entry.name.slice(0, -'.md'.length);
    if (!SAFE_NAME.test(stem)) continue;
    const file = path.join(dir, entry.name);
    if (!path.resolve(file).startsWith(root + path.sep)) continue;
    try {
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SUBAGENT_BYTES) continue;
      const { frontmatter, body } = parseSubAgentFile(fs.readFileSync(file, 'utf8'));
      if (!frontmatter.agents || frontmatter.agents.length === 0) continue;
      out.push({
        name: frontmatter.name ?? stem,
        description: frontmatter.description ?? '',
        tools: frontmatter.tools ?? [],
        ...(frontmatter.model !== undefined && { model: frontmatter.model }),
        body: body.trim(),
      });
    } catch {
      /* unreadable definition — skip it */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function listSubagents(dir: string): SubagentSummary[] {
  return readAll(dir).map(({ name, description }) => ({ name, description }));
}

export function loadSubagent(dir: string, name: string): string | null {
  if (!SAFE_NAME.test(name)) return null;
  const def = readAll(dir).find((d) => d.name === name);
  if (!def) return null;
  const header = [
    `# Sub-agent: ${def.name}`,
    ...(def.description ? [`Role: ${def.description}`] : []),
    ...(def.tools.length > 0 ? [`Tools it should use: ${def.tools.join(', ')}`] : []),
    ...(def.model ? [`Preferred model: ${def.model}`] : []),
  ];
  return `${header.join('\n')}\n\nTake on this role for the task at hand, following these instructions:\n\n${def.body}`;
}
