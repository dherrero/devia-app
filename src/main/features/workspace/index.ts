import type { Feature, FeatureContext } from '../../shared/feature';
import type {
  ConfigRepository,
  ProjectRegistry,
  SessionStore,
  PinnedStore,
  StateStore,
  SddProjectPurger,
} from '../../shared/ports';
import type { TechDetector } from './domain/ports';

import { FsWorkspaceScanner } from './infrastructure/fs-workspace-scanner';
import { NodeProjectFileSystem } from './infrastructure/node-project-file-system';
import { FsBasesStore } from './infrastructure/fs-bases-store';
import { ElectronDialogService } from './infrastructure/electron-dialog-service';

import { ListProjectsUseCase } from './application/list-projects.use-case';
import { SearchProjectsUseCase } from './application/search-projects.use-case';
import { NewProjectUseCase } from './application/new-project.use-case';
import { NewFolderUseCase } from './application/new-folder.use-case';
import { RenameFolderUseCase } from './application/rename-folder.use-case';
import { MoveProjectUseCase } from './application/move-project.use-case';
import { ListBasesUseCase } from './application/list-bases.use-case';
import { NewFromBaseUseCase } from './application/new-from-base.use-case';
import { ReadBasesJsonUseCase } from './application/read-bases-json.use-case';
import { WriteBasesJsonUseCase } from './application/write-bases-json.use-case';
import { TrashProjectUseCase } from './application/trash-project.use-case';
import { GetConfigUseCase } from './application/get-config.use-case';
import { SetConfigUseCase } from './application/set-config.use-case';

import { registerWorkspaceIpc } from './ipc/workspace.ipc';

export { FsConfigRepository } from './infrastructure/fs-config-repository';
export { FsTechDetector } from './infrastructure/fs-tech-detector';
// E-DSK-14: exposed so the composition root can build a project lister for the
// Telegram controller's /projects and /use commands without re-scanning logic.
export { FsWorkspaceScanner } from './infrastructure/fs-workspace-scanner';
export { ListProjectsUseCase } from './application/list-projects.use-case';

export interface WorkspaceDeps {
  config: ConfigRepository;
  tech: TechDetector;
  projects: ProjectRegistry;
  sessions: SessionStore;
  pinned: PinnedStore;
  state: StateStore;
  /** E-DSK-12: clears a project's SDD cache (kanban + bootstrap marker)
   *  when it is trashed. Optional so non-SDD wirings still build. */
  sddPurger?: SddProjectPurger;
}

export function buildWorkspaceFeature(deps: WorkspaceDeps): Feature {
  const scanner = new FsWorkspaceScanner(deps.config, deps.tech);
  const fileSystem = new NodeProjectFileSystem();
  const bases = new FsBasesStore(deps.config);

  const listProjects   = new ListProjectsUseCase({ scanner, tech: deps.tech, projects: deps.projects });
  const searchProjects = new SearchProjectsUseCase({ scanner, projects: deps.projects });
  const newProject     = new NewProjectUseCase({ config: deps.config, fileSystem });
  const newFolder      = new NewFolderUseCase({ config: deps.config, fileSystem });
  const renameFolder   = new RenameFolderUseCase({
    config: deps.config, fileSystem,
    projects: deps.projects, sessions: deps.sessions, state: deps.state,
  });
  const moveProject   = new MoveProjectUseCase({
    config: deps.config, fileSystem,
    projects: deps.projects, state: deps.state,
  });
  const listBases    = new ListBasesUseCase({ bases });
  const newFromBase  = new NewFromBaseUseCase({ config: deps.config, fileSystem, bases });
  const readBasesJson  = new ReadBasesJsonUseCase({ bases });
  const writeBasesJson = new WriteBasesJsonUseCase({ bases });
  const trashProject = new TrashProjectUseCase({
    config: deps.config, fileSystem,
    projects: deps.projects, sessions: deps.sessions,
    pinned: deps.pinned, state: deps.state,
    ...(deps.sddPurger !== undefined && { sddPurger: deps.sddPurger }),
  });
  const getConfig = new GetConfigUseCase(deps.config);
  const setConfig = new SetConfigUseCase(deps.config);

  return {
    id: 'workspace',
    register(ctx: FeatureContext) {
      const dialog = new ElectronDialogService(ctx.getMainWindow);
      registerWorkspaceIpc(ctx, {
        listProjects, searchProjects, newProject, newFolder, renameFolder, moveProject,
        listBases, newFromBase, readBasesJson, writeBasesJson,
        trashProject, getConfig, setConfig, dialog,
      });
    },
  };
}
