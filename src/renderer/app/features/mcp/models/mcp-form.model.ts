import type { ElectronApiService } from '../../../core/services/electron-api.service';
import type { McpAgentId, McpServerEditView, McpSource } from '../../../../types/devia';

export const ALL_AGENTS: ReadonlyArray<{ id: McpAgentId; label: string }> = [
  { id: 'claude',       label: 'Claude Code' },
  { id: 'codex',        label: 'Codex' },
  { id: 'gemini',       label: 'Gemini CLI' },
  { id: 'opencode',     label: 'OpenCode' },
  { id: 'cursor-agent', label: 'Cursor Agent' },
  { id: 'copilot',      label: 'GitHub Copilot CLI' },
  { id: 'qwen',         label: 'Qwen Code' },
  { id: 'grok',         label: 'Grok' },
  { id: 'pi',           label: 'Pi' },
];

export interface FormState {
  id: string;
  name: string;
  description: string;
  command: string;
  argsText: string;
  envText: string;
  agents: Set<McpAgentId>;
  scope: 'global' | 'project';
  source: McpSource;
  // Only used by catalog-driven installs to remember required env values.
  requiredEnv: Record<string, string>;
  requiredEnvKeys: string[];
  /** Edit only: what the form does not show but a save must not lose. */
  allowedEnvKeys?: string[];
  enabled?: boolean;
}

export type McpInstallRequest = Parameters<ElectronApiService['mcpInstall']>[0];

export function emptyForm(projectPath: string): FormState {
  return {
    id: '',
    name: '',
    description: '',
    command: '',
    argsText: '',
    envText: '',
    agents: new Set<McpAgentId>(['claude']),
    scope: projectPath === '' ? 'global' : 'global',
    source: 'manual',
    requiredEnv: {},
    requiredEnvKeys: [],
  };
}

/** Parses "KEY=VALUE" lines into a Record. Returns null on empty
 *  input, {} on malformed lines (best-effort). */
export function parseEnv(text: string): Record<string, string> | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  const out: Record<string, string> = {};
  for (const line of trimmed.split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const k = line.slice(0, eq).trim();
    const v = line.slice(eq + 1).trim();
    if (k.length === 0) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Splits the "args" field: whitespace separates arguments, and a double-quoted piece
 * stays together (spaces included), so a path with a space is representable.
 */
export function splitArgs(text: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (const m of text.matchAll(re)) out.push(m[1] ?? m[2] ?? '');
  return out;
}

/** The inverse of `splitArgs`: quotes only the arguments that contain whitespace. */
export function joinArgs(args: readonly string[]): string {
  return args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

/** "KEY=VALUE" lines, the inverse of `parseEnv`. */
export function envToText(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {}).map(([k, v]) => `${k}=${v}`).join('\n');
}

/** Fills the form from a stored server, to edit it. */
export function formFromConfig(c: McpServerEditView): FormState {
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? '',
    command: c.command,
    argsText: joinArgs(c.args),
    envText: envToText(c.env),
    agents: new Set<McpAgentId>(c.agents),
    scope: c.scope,
    source: c.source,
    requiredEnv: {},
    requiredEnvKeys: [],
    ...(c.allowedEnvKeys !== undefined && { allowedEnvKeys: c.allowedEnvKeys }),
    enabled: c.enabled,
  };
}
