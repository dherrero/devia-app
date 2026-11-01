import type { SessionStats, SessionStatsSummary } from './session-stats';
import { parseSessionStats } from './session-stats';
import type { RunMode } from './run-capabilities';

const RUN_MODES: readonly RunMode[] = ['plan', 'apply', 'apply-yolo'];

export function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

export interface SessionMeta {
  id: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  preview: string;
  isActive: boolean;
  /** Display-only rollup summary (S-7) — present when the session has stats. */
  stats?: SessionStatsSummary;
  /** CLI agent id that produced this session (S-2 F1.2) — drives the badge. */
  agentId?: string;
}

/**
 * Persisted shape of a chat session. The renderer owns the message schema;
 * main treats `messages` as opaque to avoid coupling persistence to UI
 * concerns (markdown rendering, attachment chips, etc).
 *
 * `stats` (S-7) is a denormalised per-session rollup (agent/model/context/
 * cost/compactions) the renderer maintains and main stores as passthrough —
 * the source of truth for restoring the footer and aggregating cost.
 */
export interface PersistedSession {
  id: string;
  project: string;
  createdAt: number;
  updatedAt: number;
  messages: unknown[];
  stats?: SessionStats;
  /** CLI adapter id that produced this session ('claude', 'codex', …) — S-2 F0.1. */
  agentId?: string;
  /** Native conversation id of the agent CLI (for --resume on restore) — S-2 F0.1. */
  agentSessionId?: string;
  /**
   * Absolute cwd the session runs in (S-3 F2.1) — the worktree dir for an
   * isolated pane. A HINT, not a guarantee: the worktree may have been swept;
   * consumers validate existence before reattaching (F2.2 recovery chain).
   */
  workdir?: string;
  /** Git branch of the session worktree (S-3 F2.1) — recovery source when the
   *  worktree dir was swept but the branch survived. */
  worktreeBranch?: string;
  /** Run mode the session was left in; absent ⇒ a fresh session's default (plan). */
  runMode?: RunMode;
}

/**
 * Session identity derived from a transcript (S-2 F0.1): which agent produced
 * it and the agent's native conversation id. Both optional — a session with
 * no completed run yet has neither.
 */
export interface SessionIdentity {
  agentId?: string;
  agentSessionId?: string;
}

/**
 * Walk the transcript backwards and extract the latest known identity:
 * `agentId` from the last assistant message carrying one, `agentSessionId`
 * from the last `session_started` event inside assistant `events[]`. Pure and
 * defensive — messages are `unknown[]` at the persistence boundary.
 */
export function extractSessionIdentity(messages: readonly unknown[]): SessionIdentity {
  let agentId: string | undefined;
  let agentSessionId: string | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (agentId !== undefined && agentSessionId !== undefined) break;
    const raw = messages[i];
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as { role?: unknown; agentId?: unknown; events?: unknown };
    if (msg.role !== 'assistant') continue;
    if (agentId === undefined && typeof msg.agentId === 'string' && msg.agentId.length > 0) {
      agentId = msg.agentId;
    }
    if (agentSessionId === undefined && Array.isArray(msg.events)) {
      for (let j = msg.events.length - 1; j >= 0; j--) {
        const ev = msg.events[j] as { kind?: unknown; agentSessionId?: unknown } | null;
        if (
          ev && typeof ev === 'object' && ev.kind === 'session_started' &&
          typeof ev.agentSessionId === 'string' && ev.agentSessionId.length > 0
        ) {
          agentSessionId = ev.agentSessionId;
          break;
        }
      }
    }
  }
  return {
    ...(agentId !== undefined && { agentId }),
    ...(agentSessionId !== undefined && { agentSessionId }),
  };
}

/**
 * UC-FIX-008: validate-at-boundary parser. Returns `null` when required
 * fields are absent or have the wrong type so callers can fail-safely
 * instead of crashing on stale / corrupted JSON.
 * Extra fields are accepted for forward-compatibility.
 */
export function parsePersistedSession(value: unknown): PersistedSession | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || o['id'].length === 0) return null;
  if (typeof o['project'] !== 'string') return null;
  if (typeof o['createdAt'] !== 'number') return null;
  if (typeof o['updatedAt'] !== 'number') return null;
  if (!Array.isArray(o['messages'])) return null;

  const result = o as unknown as PersistedSession;
  // Normalise `stats` defensively: a malformed rollup is dropped rather than
  // failing the whole session (the rollup is reconstructible, the chat isn't).
  const stats = o['stats'] !== undefined ? parseSessionStats(o['stats']) : null;
  if (stats) {
    result.stats = stats;
  } else {
    delete (result as { stats?: SessionStats }).stats;
  }
  // Identity (S-2 F0.1) + workdir (S-3 F2.1) fields: tolerate absence and
  // wrong types — a session written before these contracts simply lacks them.
  for (const key of ['agentId', 'agentSessionId', 'workdir', 'worktreeBranch'] as const) {
    if (typeof o[key] !== 'string' || o[key] === '') {
      delete (result as Partial<Record<typeof key, string>>)[key];
    }
  }
  if (!isRunMode(o['runMode'])) delete (result as { runMode?: RunMode }).runMode;
  return result;
}
