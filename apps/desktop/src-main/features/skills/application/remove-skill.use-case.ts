import type {
  RemoveSkillRequest,
  SkillsRunResult,
} from '../../../../shared/domain/skill';
import type { ConfigRepository } from '../../../shared/ports';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';
import { SkillInstaller } from '../infrastructure/skill-installer';

export class RemoveSkillUseCase {
  constructor(
    private readonly installer: SkillInstaller,
    private readonly config: ConfigRepository,
  ) {}

  async execute(req: RemoveSkillRequest): Promise<SkillsRunResult> {
    let absProject: string;
    try {
      absProject = resolveInsideWorkspace(this.config, req.project).abs;
    } catch (err) {
      return {
        ok: false, code: -1, output: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return this.installer.remove({ ...req, project: absProject });
  }
}
