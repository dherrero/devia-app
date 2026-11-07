import type { IpcMainInvokeEvent } from 'electron';

import { IPC } from '../../../../shared/contracts/ipc-channels';
import type { RendererEvents } from '../../../../shared/contracts/events';
import type { CodeGraphStatus, IndexProgress } from '../../../../shared/domain/code-graph';
import type { FeatureContext } from '../../../shared/feature';
import type { ConfigRepository } from '../../../shared/ports';
import {
  PathOutsideWorkspaceError,
  WorkspaceNotConfiguredError,
  resolveInsideWorkspace,
} from '../../../shared/workspace-paths';
import type { CodeGraphUseCase } from '../application/code-graph.use-case';

/**
 * IPC adapter for the code graph (S-44). `project` is a workspace-relative key
 * from the renderer, resolved inside the workspace before the use case sees it.
 * Progress and live status are pushed to the requesting webContents only.
 */
export interface CodeGraphIpcDeps {
  config: ConfigRepository;
  useCase: CodeGraphUseCase;
}

interface Sender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  once(event: 'destroyed', cb: () => void): unknown;
  on(event: 'did-start-navigation', cb: (details: NavigationDetails) => void): unknown;
  removeListener(event: string, cb: (...args: never[]) => void): unknown;
}

interface NavigationDetails {
  isMainFrame?: boolean;
  isSameDocument?: boolean;
}

interface WatchRecord {
  rel: string;
  handle: { stop(): void };
}

interface SenderWatches {
  watches: Map<string, WatchRecord>;
  detach(): void;
}

const EXPECTED_CODES = new Set(['CODE_GRAPH_NOT_CREATED', 'CODE_GRAPH_WATCH_LIMIT']);

class InvalidArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidArgumentError';
  }
}

function errorCode(err: unknown): unknown {
  return (err as { code?: unknown } | null)?.code;
}

const isAbort = (err: unknown): boolean => (err as { name?: unknown } | null)?.name === 'AbortError';

function sanitize(err: unknown): Error {
  const code = errorCode(err);
  if (typeof code === 'string' && EXPECTED_CODES.has(code)) return Object.assign(new Error(code), { code });
  if (
    err instanceof InvalidArgumentError ||
    err instanceof PathOutsideWorkspaceError ||
    err instanceof WorkspaceNotConfiguredError
  ) {
    return err;
  }
  console.warn('[code-graph] ipc failure:', err instanceof Error ? err.message : String(err));
  return new Error('Code graph operation failed');
}

function guarded<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => {
    try {
      const out = fn(...args);
      if (out instanceof Promise) return out.catch((err: unknown) => Promise.reject(sanitize(err))) as R;
      return out;
    } catch (err) {
      throw sanitize(err);
    }
  };
}

export function registerCodeGraphIpc(ctx: FeatureContext, deps: CodeGraphIpcDeps): void {
  const { config, useCase } = deps;
  const bySender = new Map<Sender, SenderWatches>();

  const resolveProject = (project: unknown): string => {
    if (typeof project !== 'string' || project.trim() === '') {
      throw new InvalidArgumentError('project must be a non-empty string');
    }
    return resolveInsideWorkspace(config, project).abs;
  };
  const requireEnabled = (enabled: unknown): boolean => {
    if (typeof enabled !== 'boolean') throw new InvalidArgumentError('enabled must be a boolean');
    return enabled;
  };
  const senderOf = (e: unknown): Sender => (e as IpcMainInvokeEvent).sender as unknown as Sender;

  const push = <K extends 'code-graph:progress' | 'code-graph:status-changed'>(
    sender: Sender,
    channel: K,
    payload: RendererEvents[K],
  ): void => {
    if (!sender.isDestroyed()) sender.send(channel, payload);
  };

  const indexFor = async (sender: Sender, rel: string, abs: string): Promise<CodeGraphStatus> => {
    try {
      return await useCase.index(abs, (progress: IndexProgress) => {
        push(sender, IPC.codeGraphProgress, { project: rel, progress });
      });
    } catch (err) {
      if (errorCode(err) === 'INDEX_BUSY' || isAbort(err)) return useCase.status(abs);
      throw err;
    }
  };

  const stopAll = (sender: Sender): void => {
    const entry = bySender.get(sender);
    if (!entry) return;
    bySender.delete(sender);
    entry.detach();
    for (const { handle } of entry.watches.values()) handle.stop();
  };

  const entryFor = (sender: Sender): SenderWatches => {
    const existing = bySender.get(sender);
    if (existing) return existing;
    const onDestroyed = (): void => stopAll(sender);
    const onNavigate = (details: NavigationDetails): void => {
      if (details.isMainFrame && !details.isSameDocument) stopAll(sender);
    };
    sender.once('destroyed', onDestroyed);
    sender.on('did-start-navigation', onNavigate);
    const entry: SenderWatches = {
      watches: new Map(),
      detach: () => {
        sender.removeListener('destroyed', onDestroyed);
        sender.removeListener('did-start-navigation', onNavigate);
      },
    };
    bySender.set(sender, entry);
    return entry;
  };

  ctx.ipc.handle(
    IPC.codeGraphStatus,
    guarded(async (_e, project: unknown): Promise<CodeGraphStatus> => useCase.status(resolveProject(project))),
  );

  ctx.ipc.handle(
    IPC.codeGraphIndex,
    guarded(async (e, project: unknown): Promise<CodeGraphStatus> => {
      const abs = resolveProject(project);
      return indexFor(senderOf(e), project as string, abs);
    }),
  );

  ctx.ipc.handle(
    IPC.codeGraphUpdate,
    guarded(async (e, project: unknown): Promise<CodeGraphStatus> => {
      const abs = resolveProject(project);
      const result = await useCase.syncNow(abs);
      if ('fullIndexRequired' in result && result.fullIndexRequired === true) return indexFor(senderOf(e), project as string, abs);
      if ('missing' in result) return indexFor(senderOf(e), project as string, abs);
      return useCase.status(abs);
    }),
  );

  ctx.ipc.handle(
    IPC.codeGraphCancel,
    guarded((_e, project: unknown): void => useCase.cancel(resolveProject(project))),
  );

  ctx.ipc.handle(
    IPC.codeGraphReset,
    guarded(async (_e, project: unknown): Promise<void> => useCase.reset(resolveProject(project))),
  );

  ctx.ipc.handle(
    IPC.codeGraphSetAgentAccess,
    guarded((_e, project: unknown, enabled: unknown): void => {
      const abs = resolveProject(project);
      useCase.setAgentAccess(abs, requireEnabled(enabled));
    }),
  );

  ctx.ipc.handle(
    IPC.codeGraphSetAutoUpdate,
    guarded((_e, project: unknown, enabled: unknown): void => {
      const abs = resolveProject(project);
      useCase.setAutoUpdate(abs, requireEnabled(enabled));
    }),
  );

  ctx.ipc.handle(
    IPC.codeGraphWatch,
    guarded((e, project: unknown): void => {
      const abs = resolveProject(project);
      const sender = senderOf(e);
      if (bySender.get(sender)?.watches.has(abs)) return;
      const rel = project as string;
      const handle = useCase.watch(abs, (status) => push(sender, IPC.codeGraphStatusChanged, { project: rel, status }));
      entryFor(sender).watches.set(abs, { rel, handle });
    }),
  );

  ctx.ipc.handle(
    IPC.codeGraphUnwatch,
    guarded((e, project: unknown): void => {
      const abs = resolveProject(project);
      const sender = senderOf(e);
      const entry = bySender.get(sender);
      const record = entry?.watches.get(abs);
      if (!entry || !record) return;
      entry.watches.delete(abs);
      record.handle.stop();
      if (entry.watches.size === 0) {
        entry.detach();
        bySender.delete(sender);
      }
    }),
  );
}
