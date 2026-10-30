import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { parseSubAgentFile } from '../../sub-agents/infrastructure/frontmatter';
import type { SubagentRef } from '../domain';

/** One entry of Claude's `--agents` JSON. */
interface ClaudeAgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  model?: string;
}

/**
 * Devia's sub-agents as Claude's native `--agents <file>` (S-30 T-356): a
 * per-run definition, so a sub-agent reaches Claude even when the sub-agent
 * manager never materialised it into `.claude/agents/`.
 *
 * One already present in `<cwd>/.claude/agents/<name>.md` is skipped — Claude
 * loads that file itself and a second definition of the same name would only
 * compete with it.
 */
export function buildClaudeAgents(
  subagents: readonly SubagentRef[],
  cwd: string,
): Record<string, ClaudeAgentDefinition> {
  const out: Record<string, ClaudeAgentDefinition> = {};
  for (const ref of subagents) {
    if (fs.existsSync(path.join(cwd, '.claude', 'agents', `${ref.name}.md`))) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(ref.file, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseSubAgentFile(raw);
    out[ref.name] = {
      description: frontmatter.description ?? ref.description,
      prompt: body.trim(),
      ...(frontmatter.tools && frontmatter.tools.length > 0 && { tools: frontmatter.tools }),
      ...(frontmatter.model !== undefined && { model: frontmatter.model }),
    };
  }
  return out;
}

/** Write the `--agents` file under `<deviaDir>/tmp/`; null when there is nothing to pass. */
export function writeClaudeAgentsFile(
  agents: Record<string, ClaudeAgentDefinition>,
  deviaDir: string,
): { path: string; cleanup(): void } | null {
  if (Object.keys(agents).length === 0) return null;
  const file = path.join(deviaDir, 'tmp', `claude-agents-${crypto.randomUUID()}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(agents, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn('[agents:claude] could not write the --agents file:', err instanceof Error ? err.message : String(err));
    return null;
  }
  return { path: file, cleanup: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } } };
}
