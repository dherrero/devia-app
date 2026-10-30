import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Default paths for Claude Code's standalone enterprise MCP file
 * (`managed-mcp.json`). When present it takes EXCLUSIVE control of MCP: Claude
 * loads only the servers it declares and rejects per-invocation MCP flags.
 * https://code.claude.com/docs/en/managed-mcp#exclusive-control-with-managed-mcp-json
 *
 * Note: the Windows path is `Program Files`, NOT `ProgramData` (that one holds
 * `managed-settings.json`).
 */
function defaultMcpPaths(env: NodeJS.ProcessEnv): string[] {
  const platform = process.platform;
  if (platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-mcp.json'];
  }
  if (platform === 'win32') {
    const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
    return [path.join(programFiles, 'ClaudeCode', 'managed-mcp.json')];
  }
  // Linux / WSL / others
  return ['/etc/claude-code/managed-mcp.json'];
}

/**
 * Default paths for the legacy enterprise MCP mechanism: an `mcpServers` object
 * embedded in `managed-settings.json`. Order is OS-specific; only the first
 * path that exists is read.
 */
function defaultSettingsPaths(env: NodeJS.ProcessEnv): string[] {
  const platform = process.platform;
  if (platform === 'darwin') {
    return ['/Library/Application Support/ClaudeCode/managed-settings.json'];
  }
  if (platform === 'win32') {
    const programData = env['PROGRAMDATA'] ?? 'C:\\ProgramData';
    return [path.join(programData, 'ClaudeCode', 'managed-settings.json')];
  }
  // Linux / others
  return ['/etc/claude-code/managed-settings.json'];
}

export interface EnterpriseMcpDetectorOpts {
  /** Override the legacy `managed-settings.json` candidates (for tests). */
  paths?: string[];
  /** Override the standalone `managed-mcp.json` candidates (for tests). */
  mcpPaths?: string[];
  /** Override the environment variable source (for tests). */
  env?: NodeJS.ProcessEnv;
}

/** Read + parse a candidate to a plain object, swallowing every error. */
function readJsonObject(candidate: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8')) as unknown;
    if (parsed !== null && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // File missing, EACCES, bad JSON, etc.
  }
  return null;
}

/**
 * Returns true when a Claude Code enterprise-managed MCP config is present and
 * would make the CLI reject Devia's per-run MCP flags (`--mcp-config` /
 * `--strict-mcp-config`). Two mechanisms are probed, exclusive-control first:
 *
 *   1. `managed-mcp.json` — a standalone admin-deployed file with EXCLUSIVE
 *      control. Its mere presence (a valid JSON object carrying an `mcpServers`
 *      key) activates the policy, EVEN when `mcpServers` is empty (an empty map
 *      means "MCP disabled entirely", but the policy is still active and Claude
 *      still rejects the flags).
 *   2. `managed-settings.json` — the legacy mechanism: a NON-empty `mcpServers`
 *      object embedded in the managed settings.
 *
 * Escape hatch: `DEVIA_ASSUME_ENTERPRISE_MCP=1` forces true; `=0` forces
 * false — lets an affected user unblock themselves immediately without
 * touching files or waiting for MDM paths to be detected automatically.
 *
 * Never throws: all errors (missing file, bad JSON, EACCES) are silently
 * swallowed and treated as "not present". (T-88)
 */
export function enterpriseMcpConfigPresent(opts?: EnterpriseMcpDetectorOpts): boolean {
  const env = opts?.env ?? process.env;
  const override = env['DEVIA_ASSUME_ENTERPRISE_MCP'];
  if (override === '1' || override === 'true') return true;
  if (override === '0' || override === 'false') return false;

  // When a caller overrides either candidate list (tests), do NOT fall back to
  // real OS paths for the other — that would read whatever is on the host.
  const useDefaults = opts?.paths === undefined && opts?.mcpPaths === undefined;
  const mcpCandidates = opts?.mcpPaths ?? (useDefaults ? defaultMcpPaths(env) : []);
  const settingsCandidates = opts?.paths ?? (useDefaults ? defaultSettingsPaths(env) : []);

  // 1) Exclusive-control file: presence with an `mcpServers` key wins, even empty.
  for (const candidate of mcpCandidates) {
    const obj = readJsonObject(candidate);
    if (obj === null) continue; // missing / unreadable / bad JSON — try next.
    const servers = obj['mcpServers'];
    if (servers !== null && typeof servers === 'object') return true;
    // File exists but isn't a managed-mcp.json shape — first-found wins.
    return false;
  }

  // 2) Legacy: a non-empty `mcpServers` embedded in managed-settings.json.
  for (const candidate of settingsCandidates) {
    const obj = readJsonObject(candidate);
    if (obj === null) continue;
    const servers = obj['mcpServers'];
    if (
      servers !== null &&
      typeof servers === 'object' &&
      Object.keys(servers as object).length > 0
    ) {
      return true;
    }
    // File exists but has no/empty mcpServers — stop here (first-found wins).
    return false;
  }
  return false;
}
