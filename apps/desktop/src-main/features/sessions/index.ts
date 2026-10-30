import type { Feature, FeatureContext } from '../../shared/feature';
import type {
  ProjectRegistry,
  QueueInspector,
  SessionStore,
  StateStore,
} from '../../shared/ports';

import { LoadChatsUseCase } from './application/load-chats.use-case';
import { LoadActiveStatsUseCase } from './application/load-active-stats.use-case';
import { AggregateStatsUseCase } from './application/aggregate-stats.use-case';
import { SaveChatUseCase } from './application/save-chat.use-case';
import { ListSessionsUseCase } from './application/list-sessions.use-case';
import { SwitchSessionUseCase } from './application/switch-session.use-case';
import { AdoptSessionUseCase } from './application/adopt-session.use-case';
import { DeleteSessionUseCase } from './application/delete-session.use-case';

import { registerSessionsIpc } from './ipc/sessions.ipc';

export { FsSessionStore } from './infrastructure/fs-session-store';

export interface SessionsDeps {
  registry: ProjectRegistry;
  sessions: SessionStore;
  state: StateStore;
  /** S-2 F0.4: pending-queue guard for session switches. */
  queue?: QueueInspector;
  /** S-2 F2.3: background handoff-summary precompute on switch/adopt. */
  prepareHandoff?: (identity: string, sessionId: string, messages: unknown[], ownerAgentId: string | null) => void;
  /** S-3 F2.2: worktree validation + recreation for the adopt recovery chain. */
  worktrees?: {
    isLive: (workdir: string) => boolean;
    recreate: (baseProject: string, sessionId: string, branch: string) => string | null;
    /** S-3: full teardown (worktree + branch) on explicit session delete. */
    cleanup: (baseProject: string, sessionId: string, branch?: string) => unknown;
  };
}

export function buildSessionsFeature(deps: SessionsDeps): Feature {
  const loadChats       = new LoadChatsUseCase({ registry: deps.registry, sessions: deps.sessions });
  const loadActiveStats = new LoadActiveStatsUseCase({ registry: deps.registry, sessions: deps.sessions });
  const aggregateStats  = new AggregateStatsUseCase({ sessions: deps.sessions });
  const saveChat        = new SaveChatUseCase({ registry: deps.registry, sessions: deps.sessions, state: deps.state });
  const listSessions    = new ListSessionsUseCase({ registry: deps.registry, sessions: deps.sessions });
  const switchSession   = new SwitchSessionUseCase({
    registry: deps.registry,
    sessions: deps.sessions,
    state: deps.state,
    ...(deps.queue !== undefined && { queue: deps.queue }),
    ...(deps.prepareHandoff !== undefined && { prepareHandoff: deps.prepareHandoff }),
  });
  const adoptSession    = new AdoptSessionUseCase({
    registry: deps.registry,
    sessions: deps.sessions,
    state: deps.state,
    ...(deps.queue !== undefined && { queue: deps.queue }),
    ...(deps.prepareHandoff !== undefined && { prepareHandoff: deps.prepareHandoff }),
    ...(deps.worktrees !== undefined && { worktrees: deps.worktrees }),
  });
  const deleteSession   = new DeleteSessionUseCase({
    registry: deps.registry,
    sessions: deps.sessions,
    state: deps.state,
    ...(deps.worktrees !== undefined && { cleanupWorktree: deps.worktrees.cleanup }),
  });

  return {
    id: 'sessions',
    register(ctx: FeatureContext) {
      registerSessionsIpc(ctx, { loadChats, loadActiveStats, aggregateStats, saveChat, listSessions, switchSession, adoptSession, deleteSession });
    },
  };
}
