import type { ElectronApiService } from '../../../core/services/electron-api.service';
import type { McpAgentId, McpSource } from '../../../../types/devia';

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
