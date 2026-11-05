import * as fs from 'node:fs';
import * as path from 'node:path';

import { THIRD_PARTY_BOOTSTRAP_SKILLS, THIRD_PARTY_CLAUDE_PLUGIN } from './third-party-methods';

/** Another method's bootstrap and this kit's own: either one installed means the agent already has a method. */
const BOOTSTRAP_SKILLS = [...THIRD_PARTY_BOOTSTRAP_SKILLS, 'using-devia'];

/** Global skill dir per agent, as the skills feature maps them; `.agents/skills` is shared by several. */
const GLOBAL_SKILL_DIRS: Record<string, readonly string[]> = {
  claude: ['.claude/skills'],
  codex: ['.codex/skills', '.agents/skills'],
  gemini: ['.gemini/skills', '.agents/skills'],
  opencode: ['.config/opencode/skills', '.agents/skills'],
  'cursor-agent': ['.cursor/skills', '.agents/skills'],
  copilot: ['.copilot/skills', '.agents/skills'],
  qwen: ['.qwen/skills'],
  qoder: ['.qoder/skills'],
  pi: ['.pi/agent/skills', '.agents/skills'],
};
const PROJECT_SKILL_DIRS: Record<string, string> = { claude: '.claude/skills', qwen: '.qwen/skills', qoder: '.qoder/skills' };

function exists(p: string): boolean {
  try {
    fs.statSync(p);
    return true;
  } catch {
    return false;
  }
}

function claudePluginInstalled(home: string): boolean {
  const manifest = path.join(home, '.claude', 'plugins', 'installed_plugins.json');
  try {
    if (new RegExp(`"${THIRD_PARTY_CLAUDE_PLUGIN}@`).test(fs.readFileSync(manifest, 'utf8'))) return true;
  } catch { /* no manifest */ }
  try {
    const cache = path.join(home, '.claude', 'plugins', 'cache');
    return fs.readdirSync(cache).some((marketplace) => exists(path.join(cache, marketplace, THIRD_PARTY_CLAUDE_PLUGIN)));
  } catch {
    return false;
  }
}

/**
 * Whether THIS agent already loads a development method on its own (a plugin of Claude Code, or a
 * bootstrap skill, ours or someone else's, in one of its skill dirs). Devia's bootstrap would then arrive
 * twice, so it steps aside. Per agent on purpose: a method installed for Codex says nothing about Gemini.
 */
export function detectNativeMethod(agentId: string, home: string, cwd: string): boolean {
  if (agentId === 'claude' && claudePluginInstalled(home)) return true;
  const projectDir = PROJECT_SKILL_DIRS[agentId] ?? '.agents/skills';
  const dirs = [path.join(cwd, projectDir), ...(GLOBAL_SKILL_DIRS[agentId] ?? ['.agents/skills']).map((d) => path.join(home, d))];
  return dirs.some((d) => BOOTSTRAP_SKILLS.some((skill) => exists(path.join(d, skill, 'SKILL.md'))));
}
