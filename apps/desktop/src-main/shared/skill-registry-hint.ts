import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Builds the short "skills are available, read the index" paragraph
 * the runner injects into every system prompt when the active project
 * has a generated registry (#269).
 *
 * Returns `null` when no registry file exists so the runner can skip
 * the injection entirely — no point teaching the agent about a file
 * that isn't there.
 *
 * Why this lives in `shared/` and not the skill-registry feature:
 *  - The runner cannot import from another feature (CLAUDE.md
 *    "Feature isolation"). A pure helper that only reads a fixed path
 *    is exactly the kind of cross-feature primitive `shared/` is for.
 *  - The function is read-only and idempotent; it does not need a
 *    use-case, dependency injection, or persistent state.
 */
const REGISTRY_REL_PATH = '.devia/skill-registry.md';

export function buildSkillRegistryHint(projectPath: string): string | null {
  if (!projectPath) return null;
  const registryPath = path.join(projectPath, REGISTRY_REL_PATH);
  let exists = false;
  try {
    exists = fs.statSync(registryPath).isFile();
  } catch {
    return null;
  }
  if (!exists) return null;

  return [
    '## Skills index',
    '',
    `A project-local skill registry is available at \`${REGISTRY_REL_PATH}\`.`,
    'Before acting on a task, scan that file. When a row\'s description',
    'matches the task, read the `SKILL.md` at the listed `Path` BEFORE',
    'proceeding. The SKILL.md body is the source of truth — never',
    'paraphrase a skill from the index.',
  ].join('\n');
}
