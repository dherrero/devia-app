/**
 * Per-session statistics rollup (S-7).
 *
 * The footer's context % and accumulated cost used to be derived live by
 * scanning the loaded session's messages for the last assistant turn's
 * `usage`. That made the values Claude-only, empty for older sessions, and
 * impossible to aggregate across projects without re-reading every message.
 *
 * `SessionStats` is a denormalised rollup persisted alongside the session
 * (`PersistedSession.stats`). It is the source of truth for:
 *   - restoring the footer when switching sessions (per-session, deterministic),
 *   - aggregating a Devia-wide cost total cheaply (read only the rollup).
 *
 * The renderer owns/maintains it (it assembles the agent stream); main treats
 * it as opaque passthrough, exactly like `messages`. Pure types + pure
 * functions only — NO Node.js / Electron / Angular imports.
 */

/** One context-compaction event recorded for a session. `postTokens` may be
 *  absent when the CLI reports only the pre-compaction size. */
export interface CompactionRecord {
  at: number;
  trigger?: 'auto' | 'manual';
  preTokens?: number;
  postTokens?: number;
}

export interface SessionStats {
  /** CLI/agent id of the LAST turn (a session can switch agents mid-way). */
  agentId: string;
  /** Model id of the last turn. */
  model?: string;
  /** Effective context window (max tokens) the CLI reported for the last run. */
  contextWindow?: number;
  /** Current context fill: input + cached tokens of the last assistant turn.
   *  Point-in-time, not cumulative — it drops after a compaction. */
  contextTokens?: number;
  /** Cumulative cost in USD across all turns (0 where the CLI doesn't report). */
  costUsd: number;
  /** Optional cost attribution by model id, for future SaaS reporting. */
  costByModel?: Record<string, number>;
  /** Number of assistant turns recorded into this rollup. */
  turnCount: number;
  /** History of context compactions (most recent last). */
  compactions: CompactionRecord[];
  /** Last time this rollup changed. */
  updatedAt: number;
}

/** Aggregate of many sessions' rollups — the Devia-wide cost view (S-7 T-84). */
export interface SessionStatsAggregate {
  grandTotalCostUsd: number;
  byModel: Record<string, number>;
  sessionCount: number;
}

/** Compact slice of a rollup for the sessions list (no compaction history). */
export interface SessionStatsSummary {
  model?: string;
  contextWindow?: number;
  contextTokens?: number;
  costUsd: number;
}

/** Project the display-only fields of a rollup for `SessionMeta`. */
export function summarizeSessionStats(stats: SessionStats): SessionStatsSummary {
  const out: SessionStatsSummary = { costUsd: stats.costUsd };
  if (stats.model !== undefined) out.model = stats.model;
  if (stats.contextWindow !== undefined) out.contextWindow = stats.contextWindow;
  if (stats.contextTokens !== undefined) out.contextTokens = stats.contextTokens;
  return out;
}

/** Minimal message shape `buildSessionStats` reads — a structural subset of
 *  the renderer's ChatMessage so the builder stays in pure shared/domain. */
export interface StatsSourceMessage {
  role: string;
  agentId?: string;
  model?: string;
  usage?: {
    inputTokens?: number;
    cachedInputTokens?: number;
    costUsd?: number;
    contextWindow?: number;
  };
}

/**
 * Derive a session rollup from its messages (S-7). The headline agent/model/
 * context reflect the LAST assistant turn that reported them; cost is summed
 * across turns (and attributed per model). `priorCompactions` is carried
 * forward unchanged so the derivation never loses compaction history. `now`
 * is injected (not read from the clock) to keep the function pure/testable.
 */
export function buildSessionStats(opts: {
  messages: ReadonlyArray<StatsSourceMessage>;
  fallbackAgentId: string;
  fallbackModel?: string;
  fallbackContextWindow?: number;
  priorCompactions?: ReadonlyArray<CompactionRecord>;
  now: number;
}): SessionStats {
  let costUsd = 0;
  const costByModel: Record<string, number> = {};
  let turnCount = 0;
  let lastAgentId: string | undefined;
  let lastModel: string | undefined;
  let lastContextTokens: number | undefined;
  let lastContextWindow: number | undefined;

  for (const m of opts.messages) {
    if (m.role !== 'assistant') continue;
    turnCount++;
    if (m.agentId) lastAgentId = m.agentId;
    if (m.model) lastModel = m.model;
    const u = m.usage;
    if (!u) continue;
    if (u.costUsd !== undefined && u.costUsd > 0) {
      costUsd += u.costUsd;
      const key = m.model ?? lastModel ?? 'unknown';
      costByModel[key] = (costByModel[key] ?? 0) + u.costUsd;
    }
    if (u.inputTokens !== undefined || u.cachedInputTokens !== undefined) {
      lastContextTokens = (u.inputTokens ?? 0) + (u.cachedInputTokens ?? 0);
    }
    if (u.contextWindow !== undefined && u.contextWindow > 0) {
      lastContextWindow = u.contextWindow;
    }
  }

  const out: SessionStats = {
    agentId: lastAgentId ?? opts.fallbackAgentId,
    costUsd: round4(costUsd),
    turnCount,
    compactions: opts.priorCompactions ? [...opts.priorCompactions] : [],
    updatedAt: opts.now,
  };
  const model = lastModel ?? opts.fallbackModel;
  if (model !== undefined) out.model = model;
  const contextWindow = lastContextWindow ?? opts.fallbackContextWindow;
  if (contextWindow !== undefined) out.contextWindow = contextWindow;
  if (lastContextTokens !== undefined) out.contextTokens = lastContextTokens;
  if (Object.keys(costByModel).length > 0) {
    for (const k of Object.keys(costByModel)) {
      const v = costByModel[k];
      if (v !== undefined) costByModel[k] = round4(v);
    }
    out.costByModel = costByModel;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function parseCompaction(value: unknown): CompactionRecord | null {
  if (!isPlainObject(value)) return null;
  if (typeof value['at'] !== 'number') return null;
  const out: CompactionRecord = { at: value['at'] };
  if (value['trigger'] === 'auto' || value['trigger'] === 'manual') out.trigger = value['trigger'];
  if (typeof value['preTokens'] === 'number') out.preTokens = value['preTokens'];
  if (typeof value['postTokens'] === 'number') out.postTokens = value['postTokens'];
  return out;
}

/**
 * Validate-at-boundary parser (mirrors `parsePersistedSession`). Returns `null`
 * when required fields are missing or mistyped so callers fail safely on stale
 * / corrupted JSON. Extra fields are accepted for forward-compatibility;
 * malformed compaction entries are dropped rather than failing the whole rollup.
 */
export function parseSessionStats(value: unknown): SessionStats | null {
  if (!isPlainObject(value)) return null;
  if (typeof value['agentId'] !== 'string' || value['agentId'].length === 0) return null;
  if (typeof value['costUsd'] !== 'number') return null;
  if (typeof value['turnCount'] !== 'number') return null;
  if (typeof value['updatedAt'] !== 'number') return null;

  const compactions = Array.isArray(value['compactions'])
    ? value['compactions'].map(parseCompaction).filter((c): c is CompactionRecord => c !== null)
    : [];

  const out: SessionStats = {
    agentId: value['agentId'],
    costUsd: value['costUsd'],
    turnCount: value['turnCount'],
    compactions,
    updatedAt: value['updatedAt'],
  };

  if (typeof value['model'] === 'string') out.model = value['model'];
  if (typeof value['contextWindow'] === 'number') out.contextWindow = value['contextWindow'];
  if (typeof value['contextTokens'] === 'number') out.contextTokens = value['contextTokens'];

  if (isPlainObject(value['costByModel'])) {
    const byModel: Record<string, number> = {};
    for (const [k, v] of Object.entries(value['costByModel'])) {
      if (typeof v === 'number') byModel[k] = v;
    }
    out.costByModel = byModel;
  }

  return out;
}

/**
 * Sum a list of session rollups into a Devia-wide total. Cost is attributed
 * per model from `costByModel` when present, otherwise the whole `costUsd`
 * is credited to `model` (or `'unknown'`). Totals are rounded to 4 decimals
 * to avoid float drift across many small per-turn costs.
 */
export function aggregateSessionStats(
  list: ReadonlyArray<SessionStats>,
): SessionStatsAggregate {
  let grand = 0;
  const byModel: Record<string, number> = {};

  for (const s of list) {
    const cost = s.costUsd || 0;
    grand += cost;
    if (s.costByModel && Object.keys(s.costByModel).length > 0) {
      for (const [model, c] of Object.entries(s.costByModel)) {
        byModel[model] = (byModel[model] ?? 0) + (c || 0);
      }
    } else if (cost > 0) {
      const model = s.model ?? 'unknown';
      byModel[model] = (byModel[model] ?? 0) + cost;
    }
  }

  for (const k of Object.keys(byModel)) {
    const v = byModel[k];
    if (v !== undefined) byModel[k] = round4(v);
  }

  return {
    grandTotalCostUsd: round4(grand),
    byModel,
    sessionCount: list.length,
  };
}
