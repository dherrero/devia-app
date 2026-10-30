import type { ListSkillsResult } from '../../../../shared/domain/skill';
import type { ConfigRepository } from '../../../shared/ports';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';
import { SkillReader } from '../infrastructure/skill-reader';

export class ListSkillsUseCase {
  constructor(
    private readonly reader: SkillReader,
    private readonly config: ConfigRepository,
  ) {}

  execute(project: string): ListSkillsResult {
    const abs = this.resolveProject(project);
    return this.reader.list(abs);
  }

  /**
   * The renderer hands us a workspace-relative project id (matches
   * `ProjectEntry.path`). Resolve to absolute so the FS scan touches the
   * real folder. Falls back to an empty string when the workspace isn't
   * configured yet — the reader then returns an empty project list.
   */
  private resolveProject(project: string): string {
    if (!project) return '';
    try {
      return resolveInsideWorkspace(this.config, project).abs;
    } catch {
      return '';
    }
  }
}
