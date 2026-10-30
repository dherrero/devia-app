/**
 * Per-run temp-file writer for Claude's `--mcp-config <file>` flag
 * (REV-AGENT-CORE-004). Produces a Claude-compatible JSON file and returns
 * its absolute path. The use case appends `['--mcp-config', path]` to argv
 * and calls `cleanup(path)` after `process:end`.
 *
 * Security:
 *   - File is written under `<deviaDir>/tmp/` so it stays in the user's home.
 *   - On POSIX, `chmod 0o600` is applied after write.
 *   - `env` values for each server are merged from `serverConfig.env` plus the
 *     allowlist-filtered subset of `process.env` (FR §14).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { McpServerConfig } from '../../../../shared/domain/mcp';

interface ClaudeMcpServerEntry {
  command: string;
  args: string[];
  env?: Record<string, string>;
}
interface ClaudeMcpConfigFile {
  mcpServers: Record<string, ClaudeMcpServerEntry>;
}

export interface TempMcpConfig {
  path: string;
  cleanup(): void;
}

export function writeTempMcpConfig(
  servers: readonly McpServerConfig[],
  deviaDir: string,
  parentEnv: NodeJS.ProcessEnv,
): TempMcpConfig | null {
  if (servers.length === 0) return null;

  const tmpDir = path.join(deviaDir, 'tmp');
  try { fs.mkdirSync(tmpDir, { recursive: true }); }
  catch { /* swallow — write below will fail loudly */ }

  const file: ClaudeMcpConfigFile = { mcpServers: {} };
  for (const s of servers) {
    const env = composeServerEnv(s, parentEnv);
    const entry: ClaudeMcpServerEntry = {
      command: s.command,
      args: s.args,
    };
    if (Object.keys(env).length > 0) entry.env = env;
    file.mcpServers[s.id] = entry;
  }

  const filename = `mcp-${crypto.randomUUID()}.json`;
  const filePath = path.join(tmpDir, filename);
  try {
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2), 'utf-8');
  } catch (err) {
    console.warn('[mcp] failed to write temp config:', err instanceof Error ? err.message : String(err));
    return null;
  }
  if (process.platform !== 'win32') {
    try { fs.chmodSync(filePath, 0o600); } catch { /* swallow */ }
  }

  return {
    path: filePath,
    cleanup(): void {
      try { fs.unlinkSync(filePath); } catch { /* swallow — best-effort */ }
    },
  };
}

/**
 * Compose the env for one MCP server. Static `s.env` values win when the same
 * key also appears in `allowedEnvKeys` and parent env, but the allowlist is the
 * gating filter for what propagates from the parent process.
 */
export function composeServerEnv(
  s: McpServerConfig,
  parentEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  const out: Record<string, string> = {};
  const allow = new Set(s.allowedEnvKeys ?? []);
  for (const key of allow) {
    const v = parentEnv[key];
    if (typeof v === 'string') out[key] = v;
  }
  if (s.env) {
    for (const [k, v] of Object.entries(s.env)) out[k] = v;
  }
  return out;
}
