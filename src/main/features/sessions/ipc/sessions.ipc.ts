import type { FeatureContext } from '../../../shared/feature';
import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { SessionStats } from '../../../../shared/domain/session-stats';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import { isRunMode } from '../../../../shared/domain/session';
import type { LoadChatsUseCase } from '../application/load-chats.use-case';
import type { LoadActiveStatsUseCase } from '../application/load-active-stats.use-case';
import type { AggregateStatsUseCase } from '../application/aggregate-stats.use-case';
import type { SaveChatUseCase } from '../application/save-chat.use-case';
import type { ListSessionsUseCase } from '../application/list-sessions.use-case';
import type { SwitchSessionUseCase } from '../application/switch-session.use-case';
import type { AdoptSessionUseCase } from '../application/adopt-session.use-case';
import type { DeleteSessionUseCase } from '../application/delete-session.use-case';

export interface SessionsIpcDeps {
  loadChats: LoadChatsUseCase;
  loadActiveStats: LoadActiveStatsUseCase;
  aggregateStats: AggregateStatsUseCase;
  saveChat: SaveChatUseCase;
  listSessions: ListSessionsUseCase;
  switchSession: SwitchSessionUseCase;
  adoptSession: AdoptSessionUseCase;
  deleteSession: DeleteSessionUseCase;
}

export function registerSessionsIpc(ctx: FeatureContext, deps: SessionsIpcDeps): void {
  ctx.ipc.handle(IPC.chatsLoadAll, () => deps.loadChats.execute());

  ctx.ipc.handle(IPC.sessionsActiveStats, () => deps.loadActiveStats.execute());

  ctx.ipc.handle(IPC.statsAggregate, () => deps.aggregateStats.execute());

  ctx.ipc.handle(IPC.chatsSave, (_e, projectPath: string, messages: unknown[], stats?: SessionStats, runMode?: RunMode) =>
    deps.saveChat.execute(projectPath, messages, stats, isRunMode(runMode) ? runMode : undefined));

  ctx.ipc.handle(IPC.chatsSaveAs, (_e, baseProject: string, sessionId: string, messages: unknown[], stats?: SessionStats, workdir?: string, worktreeBranch?: string, runMode?: RunMode) =>
    deps.saveChat.saveAs(baseProject, sessionId, messages, stats, workdir, worktreeBranch, isRunMode(runMode) ? runMode : undefined));

  ctx.ipc.handle(IPC.sessionsList, (_e, projectPath: string) =>
    deps.listSessions.execute(projectPath));

  ctx.ipc.handle(IPC.sessionSwitch, (_e, projectPath: string, sessionId: string) =>
    deps.switchSession.execute(projectPath, sessionId));

  ctx.ipc.handle(IPC.sessionAdopt, (_e, baseProject: string, runKey: string, sessionId: string) =>
    deps.adoptSession.execute(baseProject, runKey, sessionId));

  ctx.ipc.handle(IPC.sessionDelete, (_e, projectPath: string, sessionId: string) =>
    deps.deleteSession.execute(projectPath, sessionId));
}
