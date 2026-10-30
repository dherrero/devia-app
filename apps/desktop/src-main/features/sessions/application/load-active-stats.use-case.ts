import type { ProjectRegistry, SessionStore } from '../../../shared/ports';
import type { SessionStats, StatsSourceMessage } from '../../../../shared/domain/session-stats';
import { buildSessionStats } from '../../../../shared/domain/session-stats';

/**
 * Hydrate the renderer with each project's ACTIVE-session rollup (S-7), keyed
 * by project path. Used at startup so the footer can show the persisted
 * context/cost of the restored session without re-scanning its messages.
 *
 * Lazy backfill (T-85): sessions saved before stats existed have no rollup —
 * we derive one best-effort from their messages so the footer still shows
 * something. The derivation is NOT persisted here (a read shouldn't write);
 * the next save persists it properly. Projects without an active session are
 * omitted.
 */
export class LoadActiveStatsUseCase {
  constructor(private readonly deps: {
    registry: ProjectRegistry;
    sessions: SessionStore;
  }) {}

  execute(): Record<string, SessionStats> {
    const result: Record<string, SessionStats> = {};
    for (const [name, record] of this.deps.registry.entries()) {
      if (!record.activeSessionId) continue;
      const session = this.deps.sessions.load(name, record.activeSessionId);
      if (!session) continue;
      if (session.stats) {
        result[name] = session.stats;
      } else if (session.messages.length > 0) {
        result[name] = buildSessionStats({
          messages: session.messages as StatsSourceMessage[],
          fallbackAgentId: 'unknown',
          now: session.updatedAt,
        });
      }
    }
    return result;
  }
}
