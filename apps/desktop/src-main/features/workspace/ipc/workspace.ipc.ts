import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { ListProjectsUseCase } from '../application/list-projects.use-case';
import type { SearchProjectsUseCase } from '../application/search-projects.use-case';
import type { NewProjectUseCase } from '../application/new-project.use-case';
import type { NewFolderUseCase } from '../application/new-folder.use-case';
import type { RenameFolderUseCase } from '../application/rename-folder.use-case';
import type { MoveProjectUseCase } from '../application/move-project.use-case';
import type { ListBasesUseCase } from '../application/list-bases.use-case';
import type { NewFromBaseUseCase } from '../application/new-from-base.use-case';
import type { ReadBasesJsonUseCase } from '../application/read-bases-json.use-case';
import type { WriteBasesJsonUseCase } from '../application/write-bases-json.use-case';
import type { TrashProjectUseCase } from '../application/trash-project.use-case';
import type { GetConfigUseCase } from '../application/get-config.use-case';
import type { SetConfigUseCase } from '../application/set-config.use-case';
import type { DialogService } from '../domain/ports';
import type { DeviaConfig } from '../../../../shared/domain/config';

export interface WorkspaceIpcDeps {
  listProjects: ListProjectsUseCase;
  searchProjects: SearchProjectsUseCase;
  newProject: NewProjectUseCase;
  newFolder: NewFolderUseCase;
  renameFolder: RenameFolderUseCase;
  moveProject: MoveProjectUseCase;
  listBases: ListBasesUseCase;
  newFromBase: NewFromBaseUseCase;
  readBasesJson: ReadBasesJsonUseCase;
  writeBasesJson: WriteBasesJsonUseCase;
  trashProject: TrashProjectUseCase;
  getConfig: GetConfigUseCase;
  setConfig: SetConfigUseCase;
  dialog: DialogService;
}

export function registerWorkspaceIpc(ctx: FeatureContext, deps: WorkspaceIpcDeps): void {
  ctx.ipc.handle(IPC.projectsList, (_e, subpath: string | undefined) =>
    deps.listProjects.execute(subpath ?? ''));

  ctx.ipc.handle(IPC.projectsSearch, (_e, query: string | undefined) =>
    deps.searchProjects.execute(query ?? ''));

  ctx.ipc.handle(IPC.projectNew, async (_e, name: string, parentPath: string | undefined) =>
    deps.newProject.execute(name, parentPath ?? ''));

  ctx.ipc.handle(IPC.folderNew, async (_e, name: string, parentPath: string | undefined) =>
    deps.newFolder.execute(name, parentPath ?? ''));

  ctx.ipc.handle(IPC.folderRename, async (_e, folderPath: string, newName: string) =>
    deps.renameFolder.execute(folderPath, newName));

  ctx.ipc.handle(IPC.projectMove, async (_e, sourcePath: string, targetFolderPath: string) =>
    deps.moveProject.execute(sourcePath, targetFolderPath));

  ctx.ipc.handle(IPC.basesList, () => deps.listBases.execute());

  ctx.ipc.handle(IPC.basesReadJson, () => deps.readBasesJson.execute());

  ctx.ipc.handle(IPC.basesWriteJson, (_e, text: string) => deps.writeBasesJson.execute(text));

  ctx.ipc.handle(IPC.projectNewBase, async (_e, base: string, name: string, parentPath: string | undefined) =>
    deps.newFromBase.execute(base, name, parentPath ?? ''));

  ctx.ipc.handle(IPC.projectTrash, async (_e, projectPath: string) =>
    deps.trashProject.execute(projectPath));

  ctx.ipc.handle(IPC.configGet, () => deps.getConfig.execute());

  ctx.ipc.handle(IPC.configSet, (_e, partial: Partial<DeviaConfig> | undefined) => {
    const next = deps.setConfig.execute(partial ?? {});
    ctx.send('config:changed', next);
    return next;
  });

  ctx.ipc.handle(IPC.dialogPickFolder, (_e, opts: Parameters<DialogService['pickFolder']>[0]) =>
    deps.dialog.pickFolder(opts));

  ctx.ipc.handle(IPC.dialogPickFile, (_e, opts: Parameters<DialogService['pickFile']>[0]) =>
    deps.dialog.pickFile(opts));
}
