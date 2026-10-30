import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type {
  DiscoverSkillsRequest,
  InstallSkillsRequest,
  RemoveSkillRequest,
} from '../../../../shared/domain/skill';
import type { ListSkillsUseCase } from '../application/list-skills.use-case';
import type { InstallSkillsUseCase } from '../application/install-skills.use-case';
import type { RemoveSkillUseCase } from '../application/remove-skill.use-case';
import type { DiscoverSkillsUseCase } from '../application/discover-skills.use-case';
import type { SkillDiscoverer } from '../infrastructure/skill-discoverer';

export interface SkillsIpcDeps {
  list: ListSkillsUseCase;
  install: InstallSkillsUseCase;
  remove: RemoveSkillUseCase;
  discover: DiscoverSkillsUseCase;
  /** Direct handle so the cancel channel can free the temp dir. */
  discoverer: SkillDiscoverer;
}

export function registerSkillsIpc(ctx: FeatureContext, deps: SkillsIpcDeps): void {
  ctx.ipc.handle(IPC.skillsList, (_e, project: unknown) =>
    deps.list.execute(typeof project === 'string' ? project : ''),
  );

  ctx.ipc.handle(IPC.skillsInstall, (_e, req: unknown) =>
    deps.install.execute(req as InstallSkillsRequest),
  );

  ctx.ipc.handle(IPC.skillsRemove, (_e, req: unknown) =>
    deps.remove.execute(req as RemoveSkillRequest),
  );

  ctx.ipc.handle(IPC.skillsDiscover, (_e, req: unknown) =>
    deps.discover.execute(req as DiscoverSkillsRequest),
  );

  ctx.ipc.handle(IPC.skillsCancelDiscovery, (_e, discoveryId: unknown) => ({
    ok: deps.discoverer.release(typeof discoveryId === 'string' ? discoveryId : ''),
  }));
}
