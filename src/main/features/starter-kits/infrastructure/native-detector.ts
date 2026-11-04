import * as fs from 'node:fs';
import * as path from 'node:path';

const BOOTSTRAP_SKILL = 'using-superpowers';

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
    if (/"superpowers@/.test(fs.readFileSync(manifest, 'utf8'))) return true;
  } catch { /* no manifest */ }
  try {
    const cache = path.join(home, '.claude', 'plugins', 'cache');
    return fs.readdirSync(cache).some((marketplace) => exists(path.join(cache, marketplace, 'superpowers')));
  } catch {
    return false;
  }
}

/**
 * Whether THIS agent already loads Superpowers on its own (its plugin or a
 * `using-superpowers` skill in one of its skill dirs). Devia's bootstrap would
 * then arrive twice, so it steps aside. Per agent on purpose: Superpowers
 * installed for Codex says nothing about Gemini.
 */
export function detectNativeSuperpowers(agentId: string, home: string, cwd: string): boolean {
  if (agentId === 'claude' && claudePluginInstalled(home)) return true;
  const projectDir = PROJECT_SKILL_DIRS[agentId] ?? '.agents/skills';
  const dirs = [path.join(cwd, projectDir), ...(GLOBAL_SKILL_DIRS[agentId] ?? ['.agents/skills']).map((d) => path.join(home, d))];
  return dirs.some((d) => exists(path.join(d, BOOTSTRAP_SKILL, 'SKILL.md')));
}
