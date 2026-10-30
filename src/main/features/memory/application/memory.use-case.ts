import * as path from 'node:path';

import type {
  MemoryScope,
  MemorySession,
  MemorySearchHit,
  UserPromptRecord,
  Observation,
  MemoryObservationType,
  MemoryRecall,
  MemoryRecallObservation,
} from '../../../../shared/domain/memory';
import { MemoryStore } from '../infrastructure/memory-store';

// ── helpers ──────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s.trim().toLowerCase();
}

/**
 * Derive a human-readable project name from a filesystem path.
 * Uses `path.basename` — the simplest stable approach that doesn't
 * require reading any config file or spawning any process.
 */
function projectNameFromPath(p: string): string {
  // path.basename('/foo/bar') → 'bar'; path.basename('') → ''
  const base = path.basename(p.replace(/[\\/]+$/, ''));
  return base || p;
}

// ── types ─────────────────────────────────────────────────────────────────

export interface SaveObservationOpts {
  title: string;
  content: string;
  type?: MemoryObservationType;
  scope?: MemoryScope;
  project?: string;
  topicKey?: string;
  sessionId?: string;
  toolName?: string;
  projectPath?: string;
  agentId?: string;
}

export interface SearchOpts {
  type?: MemoryObservationType;
  project?: string;
  scope?: MemoryScope;
  limit?: number;
  projectPath?: string;
}

export interface ContextOpts {
  scope?: MemoryScope;
  projectPath?: string;
  project?: string;
  /**
   * Include passively auto-captured sessions (E-DSK-13 #5). Defaults to true so
   * the agent-facing `mem_context` tool sees everything; the system-prompt
   * pre-injection path passes `false` to keep the recalled feed curated.
   */
  includeAuto?: boolean;
}

export interface SessionSummaryOpts {
  content: string;
  sessionId?: string;
  scope?: MemoryScope;
  projectPath?: string;
  /** Mark this summary as passively auto-captured (E-DSK-13 #5). */
  auto?: boolean;
  /** Real session start (E-DSK-13 #318); defaults to now when omitted. */
  startedAt?: number;
  /** CLI agent id that drove this session (S-2 F1.1). */
  agentId?: string;
  /** 'handoff' appends a standalone record that the upsert path never merges (S-2 F2.2). */
  kind?: 'handoff';
}

export interface SavePromptOpts {
  content: string;
  sessionId?: string;
  project?: string;
  scope?: MemoryScope;
  projectPath?: string;
  agentId?: string;
}

export interface ContextResult {
  sessions: MemorySession[];
  recentSummaries: string[];
}

export interface RecallOpts {
  /** The current user prompt; drives the relevance search. */
  query: string;
  scope?: MemoryScope;
  projectPath?: string;
  /** Max relevant observations (default 6). */
  observationLimit?: number;
  /** Max recent session summaries for continuity (default 3). */
  summaryLimit?: number;
}

export interface CurrentProjectResult {
  project: string;
  /** Always 'path-basename': derived from projectPath via path.basename. */
  source: string;
}

// ── facade ────────────────────────────────────────────────────────────────

/**
 * Application-layer facade over MemoryStore.
 *
 * Mirrors the shape of KanbanUseCase: thin orchestration with no
 * persistence knowledge, called by both the IPC adapter (Fase 3) and
 * the MCP server (T-8). All methods default to `scope='project'`.
 */
export class MemoryUseCase {
  /** Number of recent sessions returned by context(). */
  private static readonly CONTEXT_SESSION_LIMIT = 10;

  constructor(private readonly store: MemoryStore) {}

  // ── save ────────────────────────────────────────────────────────────────

  /**
   * Persist a new observation.
   *
   * Dedup: if an active (non-deleted) observation with the same
   * normalised title+content already exists in the same scope/projectPath,
   * it is returned unchanged instead of creating a duplicate.  This is
   * intentionally simple — content-addressable, no fuzzy matching.
   */
  save(opts: SaveObservationOpts): Observation {
    const scope = opts.scope ?? 'project';
    const projectPath = opts.projectPath;

    // The topic-key/dedup decision gates a write, so it must look at the doc
    // on disk — another process may have written since this cache was warmed.
    this.store.invalidate(scope, projectPath);
    const doc = this.store.load(scope, projectPath);

    // E-DSK-13 #6: topic_key upsert. When a topic key is supplied and an active
    // observation already owns it, evolve that record in place instead of
    // appending a near-duplicate — this is how an evolving decision stays a
    // single entry rather than accreting noise across sessions.
    if (opts.topicKey !== undefined && opts.topicKey !== '') {
      const sameTopic = doc.observations.find(
        (o) => o.deletedAt === undefined && o.topicKey === opts.topicKey,
      );
      if (sameTopic) {
        const updated = this.store.updateObservation(scope, projectPath, sameTopic.id, {
          title: opts.title,
          content: opts.content,
          ...(opts.type !== undefined && { type: opts.type }),
        });
        if (updated) return updated;
      }
    }

    // Dedup check against active observations.
    const normTitle = normalize(opts.title);
    const normContent = normalize(opts.content);
    const existing = doc.observations.find(
      (o) =>
        o.deletedAt === undefined &&
        normalize(o.title) === normTitle &&
        normalize(o.content) === normContent,
    );
    if (existing) return existing;

    // Generate a stable fallback sessionId when none is supplied.
    // Convention: `manual-<projectName>` for project scope, `manual-global`
    // for personal scope, so sessions from the facade are clearly labelled.
    const sessionId =
      opts.sessionId ??
      (scope === 'personal'
        ? 'manual-global'
        : `manual-${projectNameFromPath(projectPath ?? opts.project ?? 'unknown')}`);

    return this.store.appendObservation({
      sessionId,
      type: opts.type ?? 'manual',
      title: opts.title,
      content: opts.content,
      scope,
      ...(opts.project !== undefined && { project: opts.project }),
      ...(opts.topicKey !== undefined && { topicKey: opts.topicKey }),
      ...(opts.toolName !== undefined && { toolName: opts.toolName }),
      ...(opts.agentId !== undefined && { agentId: opts.agentId }),
      ...(projectPath !== undefined && { projectPath }),
    });
  }

  // ── search ──────────────────────────────────────────────────────────────

  search(query: string, opts?: SearchOpts): MemorySearchHit[] {
    const scope = opts?.scope ?? 'project';
    return this.store.search(scope, opts?.projectPath, {
      query,
      ...(opts?.type !== undefined && { type: opts.type }),
      ...(opts?.project !== undefined && { project: opts.project }),
      ...(opts?.scope !== undefined && { scope: opts.scope }),
      ...(opts?.limit !== undefined && { limit: opts.limit }),
    });
  }

  // ── context ─────────────────────────────────────────────────────────────

  /**
   * Return recent session history and summaries for priming an agent at
   * session start. Sessions are sorted newest-first.
   */
  context(opts?: ContextOpts): ContextResult {
    const scope = opts?.scope ?? 'project';
    const includeAuto = opts?.includeAuto ?? true;
    const doc = this.store.load(scope, opts?.projectPath);

    // E-DSK-13 #5: filter auto-captured sessions BEFORE the recency limit so the
    // window is computed over curated summaries — otherwise a burst of passive
    // auto entries would push every agent-authored summary out of the top N.
    const sessions = doc.sessions
      .filter((s) => includeAuto || s.auto !== true)
      .slice()
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MemoryUseCase.CONTEXT_SESSION_LIMIT);

    const recentSummaries = sessions
      .filter((s): s is MemorySession & { summary: string } => typeof s.summary === 'string')
      .map((s) => s.summary);

    return { sessions, recentSummaries };
  }

  // ── recall (E-DSK-13 #314) ─────────────────────────────────────────────────

  /**
   * Hybrid, task-aware recall for system-prompt pre-injection: observations
   * relevant to the current prompt (lexical search, highest relevance first)
   * plus a few recent curated session summaries for continuity. An empty query
   * degrades gracefully to the most-recently-updated observations.
   */
  recall(opts: RecallOpts): MemoryRecall {
    const scope = opts.scope ?? 'project';
    const projectPath = opts.projectPath;
    const observationLimit = opts.observationLimit ?? 6;
    const summaryLimit = opts.summaryLimit ?? 3;

    const hits = this.search(opts.query, {
      scope,
      limit: observationLimit,
      ...(projectPath !== undefined && { projectPath }),
    });
    const observations: MemoryRecallObservation[] = hits.map((h) => ({
      type: h.observation.type,
      title: h.observation.title,
      content: h.observation.content,
    }));

    const summaries = this.context({
      scope,
      includeAuto: false,
      ...(projectPath !== undefined && { projectPath }),
    }).recentSummaries.slice(0, summaryLimit);

    return { observations, summaries };
  }

  // ── sessionSummary ───────────────────────────────────────────────────────

  /**
   * Close a session by storing its summary as a MemorySession with
   * `endedAt = now`.
   *
   * Decision: MemoryStore.appendSession creates a new session record.
   * We do not attempt to find an open session by `sessionId` because
   * the store has no mutation API for updating an existing session's
   * `endedAt` field — that would require exposing lower-level doc
   * access.  Creating a closed session directly is the simplest,
   * coherent approach: it captures the summary and the time range,
   * which is all that `context()` reads.
   *
   * The `project` and `directory` fields are derived from `projectPath`
   * when not otherwise available.
   */
  sessionSummary(opts: SessionSummaryOpts): MemorySession {
    const scope = opts.scope ?? 'project';
    const now = Date.now();
    const projectPath = opts.projectPath;
    const project = projectPath ? projectNameFromPath(projectPath) : 'unknown';
    const directory = projectPath ?? '';
    const startedAt = opts.startedAt ?? now;

    // E-DSK-13 #318: when the run/session id is known, upsert so the whole real
    // session collapses into ONE record — startedAt preserved on first sight,
    // endedAt/summary refreshed on later turns — instead of a synthetic record
    // per summary call. Without a sessionId we fall back to append.
    if (opts.kind === 'handoff') {
      return this.store.appendSession({
        scope,
        project,
        directory,
        startedAt,
        endedAt: now,
        summary: opts.content,
        kind: 'handoff',
        ...(opts.sessionId !== undefined && { sessionId: opts.sessionId }),
        ...(opts.agentId !== undefined && { agentId: opts.agentId }),
        ...(projectPath !== undefined && { projectPath }),
      });
    }

    if (opts.sessionId !== undefined) {
      return this.store.upsertSession({
        scope,
        sessionId: opts.sessionId,
        project,
        directory,
        startedAt,
        endedAt: now,
        summary: opts.content,
        ...(opts.auto !== undefined && { auto: opts.auto }),
        ...(opts.agentId !== undefined && { agentId: opts.agentId }),
        ...(projectPath !== undefined && { projectPath }),
      });
    }

    return this.store.appendSession({
      scope,
      project,
      directory,
      startedAt,
      endedAt: now,
      summary: opts.content,
      ...(opts.auto !== undefined && { auto: opts.auto }),
      ...(opts.agentId !== undefined && { agentId: opts.agentId }),
      ...(projectPath !== undefined && { projectPath }),
    });
  }

  // ── recentSessionSummary (S-2 F3.4) ────────────────────────────────────────

  /**
   * Newest summary a SPECIFIC agent recorded for a session, when fresh enough
   * — the rich handoff summary the previous agent produced on request. Handoff
   * records themselves are excluded (they are the OUTPUT of a handoff, not a
   * source for the next one).
   */
  recentSessionSummary(opts: {
    sessionId: string;
    agentId: string;
    maxAgeMs: number;
    projectPath?: string;
  }): string | null {
    const doc = this.store.load('project', opts.projectPath);
    const now = Date.now();
    const hit = doc.sessions
      .filter((s) =>
        s.sessionId === opts.sessionId &&
        s.agentId === opts.agentId &&
        s.kind !== 'handoff' &&
        typeof s.summary === 'string' && s.summary.length > 0 &&
        now - (s.endedAt ?? s.startedAt) <= opts.maxAgeMs,
      )
      .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt))[0];
    return hit?.summary ?? null;
  }

  // ── getObservation ───────────────────────────────────────────────────────

  getObservation(
    id: string,
    opts?: { scope?: MemoryScope; projectPath?: string },
  ): Observation | undefined {
    const scope = opts?.scope ?? 'project';
    return this.store.getObservation(scope, opts?.projectPath, id);
  }

  // ── savePrompt ───────────────────────────────────────────────────────────

  savePrompt(opts: SavePromptOpts): UserPromptRecord {
    const scope = opts.scope ?? 'project';
    const projectPath = opts.projectPath;
    const sessionId =
      opts.sessionId ??
      (scope === 'personal'
        ? 'manual-global'
        : `manual-${projectNameFromPath(projectPath ?? opts.project ?? 'unknown')}`);

    return this.store.appendPrompt({
      sessionId,
      content: opts.content,
      createdAt: Date.now(),
      scope,
      ...(opts.project !== undefined && { project: opts.project }),
      ...(opts.agentId !== undefined && { agentId: opts.agentId }),
      ...(projectPath !== undefined && { projectPath }),
    });
  }

  // ── setPinned ────────────────────────────────────────────────────────────

  setPinned(
    id: string,
    pinned: boolean,
    opts?: { scope?: MemoryScope; projectPath?: string },
  ): Observation | undefined {
    const scope = opts?.scope ?? 'project';
    return this.store.setPinned(scope, opts?.projectPath, id, pinned);
  }

  // ── forget ───────────────────────────────────────────────────────────────

  forget(
    id: string,
    opts?: { scope?: MemoryScope; projectPath?: string },
  ): boolean {
    const scope = opts?.scope ?? 'project';
    return this.store.softDelete(scope, opts?.projectPath, id);
  }

  // ── clear ────────────────────────────────────────────────────────────────

  /** Wipe an entire memory scope to empty (E-DSK-13 #320, clear all). */
  clear(opts?: { scope?: MemoryScope; projectPath?: string }): void {
    this.store.clear(opts?.scope ?? 'project', opts?.projectPath);
  }

  // ── currentProject ───────────────────────────────────────────────────────

  /**
   * Derive the current project name from a filesystem path.
   *
   * Source: `path-basename` — uses `path.basename(projectPath)`.
   * No workspace scanner or git probe is invoked here; the MCP server
   * receives `--project` at startup and passes it through, so the
   * basename is always stable and process-free.
   */
  currentProject(projectPath?: string): CurrentProjectResult {
    if (!projectPath) {
      return { project: 'unknown', source: 'path-basename' };
    }
    return { project: projectNameFromPath(projectPath), source: 'path-basename' };
  }
}
