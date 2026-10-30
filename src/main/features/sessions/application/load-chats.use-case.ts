import type { ProjectRegistry, SessionStore } from '../../../shared/ports';
import type { ChatMessage } from '../../../../shared/domain/chat';

/**
 * Hydrate the renderer with the active session's messages for every project
 * that has one. Returns `{ [projectPath]: messages[] }`.
 *
 * TS-CLI-07 crash recovery: any message persisted with `runStatus: 'running'`
 * indicates the app was killed mid-stream. We downgrade those to `'failed'`
 * with an `endedAt` timestamp so the UI shows a clear "crashed run" indicator
 * instead of an infinite spinner.
 */
export class LoadChatsUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
  }) {}

  execute(): Record<string, unknown[]> {
    const result: Record<string, unknown[]> = {};
    for (const [name, record] of this.deps.registry.entries()) {
      if (!record.activeSessionId) continue;
      const session = this.deps.sessions.load(name, record.activeSessionId);
      if (session?.messages) {
        result[name] = this.applyRecovery(session.messages);
      }
    }
    return result;
  }

  /**
   * Downgrade any messages that were still `runStatus: 'running'` when the
   * app shut down (or crashed). Those runs can never complete now, so we
   * mark them as `'failed'` with the current timestamp as `endedAt`.
   *
   * Messages without `runStatus` (old persisted format) are passed through
   * unchanged — all TS-CLI-07 fields are optional, so no migration is needed.
   */
  private applyRecovery(messages: unknown[]): unknown[] {
    const now = Date.now();
    return messages.map((raw) => {
      const msg = raw as Partial<ChatMessage>;
      if (msg.runStatus === 'running') {
        return { ...msg, runStatus: 'failed', endedAt: now } satisfies Partial<ChatMessage>;
      }
      return raw;
    });
  }
}
