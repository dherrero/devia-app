import type {
  InstallSkillsRequest,
  SkillsRunResult,
} from '../../../../shared/domain/skill';
import type { ConfigRepository } from '../../../shared/ports';
import { resolveInsideWorkspace } from '../../../shared/workspace-paths';
import { SkillInstaller } from '../infrastructure/skill-installer';

export class InstallSkillsUseCase {
  constructor(
    private readonly installer: SkillInstaller,
    private readonly config: ConfigRepository,
  ) {}

  async execute(req: InstallSkillsRequest): Promise<SkillsRunResult> {
    let absProject: string;
    try {
      absProject = resolveInsideWorkspace(this.config, req.project).abs;
    } catch (err) {
      return {
        ok: false, code: -1, output: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
    return this.installer.install({ ...req, project: absProject });
  }
}
