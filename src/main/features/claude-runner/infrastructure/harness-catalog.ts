import type { SubAgentView } from '../../../../shared/domain/sub-agents';
import type { SkillListReader } from '../../../shared/ports';
import type { SkillRef, SubagentRef } from '../../agents/domain';
import type { HarnessCatalog } from '../domain/ports';

/**
 * `HarnessCatalog` over the managers that already own each piece (S-30 T-356):
 * the skills manager's reader (every agent's project + global skill dirs) and
 * the sub-agent manager's source of truth (`.devia/sub-agents`).
 */
export function createHarnessCatalog(deps: {
  skills: SkillListReader;
  subagents: (projectAbs: string) => readonly SubAgentView[];
}): HarnessCatalog {
  return {
    skills(cwd: string): SkillRef[] {
      const { project, global } = deps.skills.list(cwd);
      // Project skills first: on a name clash the checkout wins over the home dir.
      const seen = new Set<string>();
      const out: SkillRef[] = [];
      for (const s of [...project, ...global]) {
        if (seen.has(s.absolutePath)) continue;
        seen.add(s.absolutePath);
        out.push({ name: s.name, description: s.description, dir: s.absolutePath });
      }
      return out;
    },
    subagents(projectCheckout: string): SubagentRef[] {
      // A definition with no target agent is parked by the user: keep it off.
      return deps.subagents(projectCheckout)
        .filter((a) => a.agents.length > 0)
        .map((a) => ({ name: a.name, description: a.description, file: a.sourcePath }));
    },
  };
}
