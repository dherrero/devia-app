import type { ListSkillsResult } from '../../../shared/domain/skill';

/**
 * Read-side port that exposes a project + global skill scan.
 *
 * Implemented by `src-main/features/skills/infrastructure/skill-reader.ts`
 * and consumed by the skill-registry feature (#269). Keeping the
 * contract in `shared/ports/` means skill-registry never imports
 * from inside `features/skills/` — it talks to the composition root
 * through the same port the skills feature already implements.
 */
export interface SkillListReader {
  list(projectPath: string): ListSkillsResult;
}
