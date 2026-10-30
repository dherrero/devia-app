/**
 * Strict-shape validator for MCP server config entries (REV-AGENT-CORE-004).
 *
 * Rejects entries that don't match the documented schema. Returns the
 * sanitised entry or `null`. Used at the boundary between
 * `mcp-servers.json` (untrusted) and the registry (trusted).
 *
 * Security rules (FR §TR4, §14):
 *   - `command` must be either a PATH-visible executable name or an
 *     absolute filesystem path. Shell syntax is rejected.
 *   - `args` entries must be strings (no objects or functions).
 *   - `env` values must be strings (no `null`, no objects).
 *   - `allowedEnvKeys` entries must match `[A-Z_][A-Z0-9_]*` — uppercase
 *     env-var naming convention.
 */

import type {
  McpAgentId,
  McpScope,
  McpServerConfig,
  McpSource,
} from '../../../../shared/domain/mcp';
import * as path from 'node:path';

const COMMAND_PATTERN = /^[A-Za-z0-9._-][A-Za-z0-9._-]*$/;
// eslint-disable-next-line no-control-regex -- control chars are exactly what we reject
const COMMAND_SHELL_META_PATTERN = /[\x00-\x1f"'`|<>&;$]/;
const ENV_KEY_PATTERN = /^[A-Z_][A-Z0-9_]*$/;
const AGENT_IDS: ReadonlySet<McpAgentId> = new Set([
  'claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'copilot', 'qwen', 'grok', 'pi',
]);
const SCOPES: ReadonlySet<McpScope> = new Set(['global', 'project']);
const SOURCES: ReadonlySet<McpSource> = new Set(['npm', 'uvx', 'binary', 'manual']);

export function validateServerConfig(value: unknown): McpServerConfig | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const id = strField(obj['id']);
  const name = strField(obj['name']);
  const command = strField(obj['command']);
  if (id === null || name === null || command === null) return null;
  if (!isSafeCommand(command)) return null;

  const args = strArray(obj['args']);
  if (args === null) return null;

  const enabled = typeof obj['enabled'] === 'boolean' ? obj['enabled'] : false;

  const result: McpServerConfig = { id, name, command, args, enabled };

  // env: optional Record<string, string>; reject non-string values.
  if (obj['env'] !== undefined) {
    const env = strRecord(obj['env']);
    if (env === null) return null;
    if (Object.keys(env).length > 0) result.env = env;
  }

  // allowedEnvKeys: optional string[]; uppercase env-var naming only.
  if (obj['allowedEnvKeys'] !== undefined) {
    const keys = strArray(obj['allowedEnvKeys']);
    if (keys === null) return null;
    const safe = keys.filter(k => ENV_KEY_PATTERN.test(k));
    if (safe.length > 0) result.allowedEnvKeys = safe;
  }

  // #272 fields — all optional, default-applied at consumer time.
  if (typeof obj['description'] === 'string' && obj['description'].length <= 500) {
    result.description = obj['description'];
  }
  if (Array.isArray(obj['agents'])) {
    const agents = obj['agents'].filter(
      (a): a is McpAgentId => typeof a === 'string' && AGENT_IDS.has(a as McpAgentId),
    );
    if (agents.length > 0) result.agents = agents;
  }
  if (typeof obj['scope'] === 'string' && SCOPES.has(obj['scope'] as McpScope)) {
    result.scope = obj['scope'] as McpScope;
  }
  if (typeof obj['source'] === 'string' && SOURCES.has(obj['source'] as McpSource)) {
    result.source = obj['source'] as McpSource;
  }
  if (typeof obj['createdAt'] === 'number' && obj['createdAt'] >= 0) {
    result.createdAt = obj['createdAt'];
  }
  if (typeof obj['pinned'] === 'boolean') {
    result.pinned = obj['pinned'];
  }

  // exposure: optional; one of the four PI exposure levels.
  if (typeof obj['exposure'] === 'string') {
    const validExposures = new Set(['direct', 'deferred', 'codemode', 'hidden']);
    if (validExposures.has(obj['exposure'])) {
      result.exposure = obj['exposure'] as 'direct' | 'deferred' | 'codemode' | 'hidden';
    }
  }

  return result;
}

function isSafeCommand(command: string): boolean {
  if (COMMAND_SHELL_META_PATTERN.test(command)) return false;
  if (COMMAND_PATTERN.test(command)) return true;

  // Absolute paths are safe to pass to spawn without a shell and are needed
  // for bundled GUI/runtime binaries such as OpenDesign's Electron executable.
  return path.win32.isAbsolute(command) || path.posix.isAbsolute(command);
}

function strField(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const trimmed = v.trim();
  if (trimmed.length === 0 || trimmed.length > 256) return null;
  return trimmed;
}

function strArray(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') return null;
    out.push(x);
  }
  return out;
}

function strRecord(v: unknown): Record<string, string> | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val !== 'string') return null;
    out[k] = val;
  }
  return out;
}
