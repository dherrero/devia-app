import type { SkillAgent } from '../../../../shared/domain/skill';

/**
 * Devia → per-agent skill directory mapping.
 *
 *  - `cliFlag`     — kept for backwards compatibility with the previous
 *                    `npx skills` integration; the current install
 *                    pipeline doesn't actually read it any more.
 *  - `projectDir`  — relative dir under the project root that the agent
 *                    loads skills from.
 *  - `globalDir`   — absolute dir (under $HOME) for the global skill scope.
 *
 * Five agents (Codex, Gemini, OpenCode, Cursor, Copilot) all consume
 * `.agents/skills/` at project scope, so a single skill folder in there
 * is shared by all of them. Qwen and Qoder use vendor-specific dirs only;
 * a skill must be installed twice if you want it under both. DeepSeek has
 * no canonical CLI with documented skills support — it is intentionally
 * not present here, which makes install/remove for DeepSeek a no-op.
 *
 * Sources (verified May 2026):
 *  - Claude:  https://code.claude.com/docs/skills
 *  - Codex:   https://developers.openai.com/codex/skills
 *  - Gemini:  https://github.com/google-gemini/gemini-cli (skills feature)
 *  - OpenCode: https://opencode.ai/docs/skills/
 *  - Cursor:  https://cursor.com/docs/context/skills
 *  - Copilot: https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills
 *  - Qwen:    https://qwenlm.github.io/qwen-code-docs/en/users/features/skills/
 *  - Qoder:   https://docs.qoder.com/cli/Skills
 */
export interface SkillAgentMapping {
  agent: SkillAgent;
  cliFlag: string;
  projectDir: string;
  globalDir: (home: string) => string;
}

export const SKILL_AGENT_MAP: readonly SkillAgentMapping[] = [
  {
    agent: 'claude',
    cliFlag: 'claude-code',
    projectDir: '.claude/skills',
    globalDir: (home) => `${home}/.claude/skills`,
  },
  {
    agent: 'codex',
    cliFlag: 'codex',
    projectDir: '.agents/skills',
    globalDir: (home) => `${home}/.codex/skills`,
  },
  {
    agent: 'gemini',
    cliFlag: 'gemini-cli',
    projectDir: '.agents/skills',
    globalDir: (home) => `${home}/.gemini/skills`,
  },
  {
    agent: 'opencode',
    cliFlag: 'opencode',
    projectDir: '.agents/skills',
    globalDir: (home) => `${home}/.config/opencode/skills`,
  },
  {
    agent: 'cursor-agent',
    cliFlag: 'cursor',
    projectDir: '.agents/skills',
    globalDir: (home) => `${home}/.cursor/skills`,
  },
  {
    agent: 'copilot',
    cliFlag: 'copilot',
    projectDir: '.agents/skills',
    globalDir: (home) => `${home}/.copilot/skills`,
  },
  {
    agent: 'qwen',
    cliFlag: 'qwen',
    projectDir: '.qwen/skills',
    globalDir: (home) => `${home}/.qwen/skills`,
  },
  {
    agent: 'qoder',
    cliFlag: 'qoder',
    projectDir: '.qoder/skills',
    globalDir: (home) => `${home}/.qoder/skills`,
  },
] as const;

export function agentByCliFlag(flag: string): SkillAgentMapping | undefined {
  return SKILL_AGENT_MAP.find((m) => m.cliFlag === flag);
}

export function agentById(id: SkillAgent): SkillAgentMapping | undefined {
  return SKILL_AGENT_MAP.find((m) => m.agent === id);
}
