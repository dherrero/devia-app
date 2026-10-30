import type { SessionStore } from '../../../shared/ports';
import type { SessionStatsAggregate } from '../../../../shared/domain/session-stats';
import { aggregateSessionStats } from '../../../../shared/domain/session-stats';

/**
 * Devia-wide cost aggregate (S-7 T-84): sum every session's rollup across all
 * projects into a grand total + per-model breakdown, reading only the rollups
 * (never the full message arrays). This is the shape that would later be
 * pushed to the SaaS backend.
 */
export class AggregateStatsUseCase {
  constructor(private readonly deps: { sessions: SessionStore }) {}

  execute(): SessionStatsAggregate {
    return aggregateSessionStats(this.deps.sessions.collectAllStats());
  }
}
