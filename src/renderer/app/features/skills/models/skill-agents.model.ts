import type { SkillAgent } from '../../../../types/devia';

export interface AgentOption {
  id: SkillAgent;
  label: string;
}

export const ALL_AGENTS: AgentOption[] = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'gemini', label: 'Gemini CLI' },
  { id: 'opencode', label: 'OpenCode' },
  { id: 'cursor-agent', label: 'Cursor Agent' },
  { id: 'copilot', label: 'GitHub Copilot CLI' },
  { id: 'qwen', label: 'Qwen Code' },
  { id: 'qoder', label: 'Qoder CLI' },
];

export function agentLabel(id: SkillAgent): string {
  return ALL_AGENTS.find((a) => a.id === id)?.label ?? id;
}
