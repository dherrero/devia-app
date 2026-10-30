import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { McpServerConfig } from '../../../../shared/domain/mcp';
import { composeServerEnv } from '../../mcp/infrastructure/temp-config-writer';
import { McpSyncWriter } from '../../mcp/infrastructure/mcp-sync-writer';
import { resolveAgentTarget } from '../../mcp/domain/agent-targets';
import { parseSubAgentFile } from '../../sub-agents/infrastructure/frontmatter';
import type { SubagentRef } from '../domain';

/** OpenCode's `McpLocalConfig`: the WHOLE argv in `command`, env under `environment`. */
interface OpencodeLocalMcp {
  type: 'local';
  command: string[];
  environment?: Record<string, string>;
}

interface OpencodeAgent {
  description: string;
  mode: 'subagent';
  prompt: string;
}

export interface OpencodeRunConfig {
  $schema: string;
  mcp: Record<string, OpencodeLocalMcp>;
  agent?: Record<string, OpencodeAgent>;
}

/**
 * The per-run config OpenCode loads through `OPENCODE_CONFIG` (merged with the
 * project's and the user's own config — verified against opencode 1.19.3).
 * It carries Devia's AND the user's MCP-manager servers plus Devia's
 * sub-agents as native OpenCode sub-agents (S-30 T-356).
 *
 * Why not the project `opencode.json`: it lives in the user's repository, and
 * a user server's env (tokens) would be written into it. The per-run file
 * lives under `<deviaDir>/tmp/`, owner-only, and is removed after the run.
 */
export function buildOpencodeRunConfig(
  servers: readonly McpServerConfig[],
  subagents: readonly SubagentRef[],
  parentEnv: NodeJS.ProcessEnv,
): OpencodeRunConfig {
  const mcp: Record<string, OpencodeLocalMcp> = {};
  for (const s of servers) {
    const env = composeServerEnv(s, parentEnv);
    mcp[s.id] = {
      type: 'local',
      command: [s.command, ...s.args],
      ...(Object.keys(env).length > 0 && { environment: env }),
    };
  }
  const agent: Record<string, OpencodeAgent> = {};
  for (const ref of subagents) {
    let raw: string;
    try {
      raw = fs.readFileSync(ref.file, 'utf8');
    } catch {
      continue;
    }
    const { frontmatter, body } = parseSubAgentFile(raw);
    // Tools / model use Claude's vocabulary; OpenCode's differ, so the
    // sub-agent inherits OpenCode's defaults rather than a wrong mapping.
    agent[ref.name] = { description: frontmatter.description ?? ref.description, mode: 'subagent', prompt: body.trim() };
  }
  return {
    $schema: 'https://opencode.ai/config.json',
    mcp,
    ...(Object.keys(agent).length > 0 && { agent }),
  };
}

export function writeOpencodeRunConfig(
  config: OpencodeRunConfig,
  deviaDir: string,
): { path: string; cleanup(): void } | null {
  const file = path.join(deviaDir, 'tmp', `opencode-${crypto.randomUUID()}.json`);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 });
  } catch (err) {
    console.warn('[agents:opencode] could not write the per-run config:', err instanceof Error ? err.message : String(err));
    return null;
  }
  return { path: file, cleanup: () => { try { fs.unlinkSync(file); } catch { /* already gone */ } } };
}

/** Devia's bundled ids earlier versions wrote into the project `opencode.json`. */
const RETIRED_IDS = ['devia-memory', 'devia-kanban', 'devia-ui', 'devia-ask'];

/**
 * Remove the Devia-managed bundled entries earlier versions wrote into the
 * project `opencode.json` (a stale `devia-ui` points at a dead per-run
 * rendezvous dir). Hand-added servers and the MCP manager's entries stay; a
 * file left empty is deleted. Best-effort.
 */
export function retireOpencodeProjectMcp(cwd: string, home: string): void {
  const target = resolveAgentTarget('opencode', 'project', { home, project: cwd });
  if (!target || !fs.existsSync(target.file)) return;
  try {
    new McpSyncWriter().write({
      agent: 'opencode',
      target,
      managed: [],
      removedIds: RETIRED_IDS,
      parentEnv: process.env,
      prune: false,
    });
    const left = JSON.parse(fs.readFileSync(target.file, 'utf8')) as Record<string, unknown>;
    if (Object.keys(left).length === 0) fs.unlinkSync(target.file);
  } catch (err) {
    console.warn('[agents:opencode] could not clean Devia entries from opencode.json:', err instanceof Error ? err.message : String(err));
  }
}
