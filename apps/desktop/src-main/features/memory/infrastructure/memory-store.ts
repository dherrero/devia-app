import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  MemoryScope,
  MemoryStoreDoc,
  Observation,
  MemoryObservationType,
  MemorySession,
  UserPromptRecord,
  MemorySearchQuery,
  MemorySearchHit,
} from '../../../../shared/domain/memory';

/**
 * JSON-backed memory store (Phase 1).
 *
 * Two document shapes, both managed by this class:
 *   personal scope → <deviaDir>/memory-global.json
 *   project scope  → <deviaDir>/projects/<key>/memory.json
 *
 * Written atomically (tmp + rename). In-memory cache keyed by the
 * canonical cache key so repeated reads within a request don't parse
 * disk. Every mutation goes through save() which refreshes the cache.
 */
export class MemoryStore {
  private readonly cache = new Map<string, MemoryStoreDoc>();
  /** Per-array caps so the JSON store can't grow unbounded (E-DSK-13 #316). */
  private readonly limits: { observations: number; sessions: number; prompts: number };

  constructor(
    private readonly deviaDir: () => string,
    limits: Partial<{ observations: number; sessions: number; prompts: number }> = {},
  ) {
    this.limits = {
      observations: limits.observations ?? 500,
      sessions: limits.sessions ?? 200,
      prompts: limits.prompts ?? 300,
    };
  }

  /**
   * Bound each array to its cap, keeping the most recent entries (E-DSK-13 #316):
   * by timestamp, with a stable tiebreak on the monotonic id sequence so equal
   * timestamps (same-ms writes) still drop the genuinely-oldest. Called on every
   * append, so the file stays bounded continuously rather than growing forever.
   *
   * Pinned observations are always kept; only the non-pinned remainder is subject
   * to the cap so a user-pinned entry is never silently evicted.
   */
  private enforceLimits(doc: MemoryStoreDoc): void {
    if (doc.observations.length > this.limits.observations) {
      const pinned = doc.observations.filter((o) => o.pinned === true);
      const unpinned = doc.observations.filter((o) => o.pinned !== true);
      const keepCount = Math.max(0, this.limits.observations - pinned.length);
      const keptUnpinned = unpinned
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt || seqOf(b.id) - seqOf(a.id))
        .slice(0, keepCount);
      doc.observations = [...pinned, ...keptUnpinned];
    }
    if (doc.sessions.length > this.limits.sessions) {
      doc.sessions = doc.sessions
        .slice()
        .sort((a, b) => b.startedAt - a.startedAt || seqOf(b.id) - seqOf(a.id))
        .slice(0, this.limits.sessions);
    }
    if (doc.prompts.length > this.limits.prompts) {
      doc.prompts = doc.prompts
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt || seqOf(b.id) - seqOf(a.id))
        .slice(0, this.limits.prompts);
    }
  }

  // ── path helpers ────────────────────────────────────────────────

  /** Same algorithm as KanbanStore.keyForPath — must stay in sync. */
  static keyForPath(projectPath: string): string {
    return projectPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private cacheKey(scope: MemoryScope, projectPath?: string): string {
    if (scope === 'personal') return '__global__';
    if (!projectPath) throw new Error('project scope requires projectPath');
    return MemoryStore.keyForPath(projectPath);
  }

  fileFor(scope: MemoryScope, projectPath?: string): string {
    if (scope === 'personal') {
      return path.join(this.deviaDir(), 'memory-global.json');
    }
    if (!projectPath) throw new Error('project scope requires projectPath');
    return path.join(
      this.deviaDir(),
      'projects',
      MemoryStore.keyForPath(projectPath),
      'memory.json',
    );
  }

  // ── CRUD ────────────────────────────────────────────────────────

  load(scope: MemoryScope, projectPath?: string): MemoryStoreDoc {
    const key = this.cacheKey(scope, projectPath);
    const cached = this.cache.get(key);
    if (cached) return cached;

    let doc: MemoryStoreDoc | null = null;
    try {
      const raw = fs.readFileSync(this.fileFor(scope, projectPath), 'utf8');
      doc = parseDoc(JSON.parse(raw), scope, projectPath);
    } catch {
      doc = null;
    }
    const result = doc ?? freshDoc(scope, projectPath);
    this.cache.set(key, result);
    return result;
  }

  save(doc: MemoryStoreDoc): void {
    const key = this.cacheKey(doc.scope, doc.projectPath);
    this.cache.set(key, doc);
    const file = this.fileFor(doc.scope, doc.projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Drop the cached copy so the next load() re-reads from disk.
   *  Used after an out-of-process MCP tool mutates the file. */
  invalidate(scope: MemoryScope, projectPath?: string): void {
    this.cache.delete(this.cacheKey(scope, projectPath));
  }

  /** Every read-modify-write MUST start from disk, never from the cache: the
   *  devia-memory MCP server mutates the same file from another process, so a
   *  doc cached at run start can be minutes stale — save()-ing it back would
   *  silently drop everything written since (this is how mem_save observations
   *  were lost to the main process's run-end auto-summary). Plain reads keep
   *  the cache; save() refreshes it. */
  private loadFresh(scope: MemoryScope, projectPath?: string): MemoryStoreDoc {
    this.invalidate(scope, projectPath);
    return this.load(scope, projectPath);
  }

  /** Wipe a scope's store to an empty document (E-DSK-13 #320, clear all). */
  clear(scope: MemoryScope, projectPath?: string): void {
    this.save(freshDoc(scope, projectPath));
  }

  // ── Observation mutations ────────────────────────────────────────

  appendObservation(
    input: Omit<Observation, 'id' | 'createdAt' | 'updatedAt'> & {
      scope: MemoryScope;
      projectPath?: string;
    },
  ): Observation {
    const { projectPath, ...fields } = input;
    const doc = this.loadFresh(fields.scope, projectPath);
    const id = `obs-${doc.nextObsSeq}`;
    doc.nextObsSeq += 1;
    const now = Date.now();
    // Build the observation respecting exactOptionalPropertyTypes:
    // optional fields are spread conditionally so they are absent, not undefined.
    const obs: Observation = {
      id,
      sessionId: fields.sessionId,
      type: fields.type,
      title: fields.title,
      content: fields.content,
      scope: fields.scope,
      createdAt: now,
      updatedAt: now,
      ...(fields.syncId !== undefined && { syncId: fields.syncId }),
      ...(fields.project !== undefined && { project: fields.project }),
      ...(fields.topicKey !== undefined && { topicKey: fields.topicKey }),
      ...(fields.toolName !== undefined && { toolName: fields.toolName }),
      ...(fields.agentId !== undefined && { agentId: fields.agentId }),
      ...(fields.pinned === true && { pinned: true }),
    };
    doc.observations.push(obs);
    this.enforceLimits(doc);
    this.save(doc);
    return obs;
  }

  getObservation(
    scope: MemoryScope,
    projectPath: string | undefined,
    id: string,
  ): Observation | undefined {
    return this.load(scope, projectPath).observations.find((o) => o.id === id);
  }

  /**
   * Update an active observation in place (E-DSK-13 #6, topic_key upsert).
   * Rebuilds the record (the domain type marks `type` readonly) and bumps
   * `updatedAt`. Returns undefined when the id is unknown or soft-deleted.
   */
  updateObservation(
    scope: MemoryScope,
    projectPath: string | undefined,
    id: string,
    patch: { title?: string; content?: string; type?: MemoryObservationType },
  ): Observation | undefined {
    const doc = this.loadFresh(scope, projectPath);
    const idx = doc.observations.findIndex((o) => o.id === id);
    if (idx === -1) return undefined;
    const current = doc.observations[idx];
    if (!current) return undefined;
    if (current.deletedAt !== undefined) return undefined;
    const updated: Observation = {
      ...current,
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.content !== undefined && { content: patch.content }),
      ...(patch.type !== undefined && { type: patch.type }),
      updatedAt: Date.now(),
    };
    doc.observations[idx] = updated;
    this.save(doc);
    return updated;
  }

  /**
   * Set or clear the pinned flag on an active observation. Rebuilds the record
   * immutably (mirroring updateObservation) and bumps updatedAt. Returns
   * undefined when the id is unknown or soft-deleted.
   */
  setPinned(
    scope: MemoryScope,
    projectPath: string | undefined,
    id: string,
    pinned: boolean,
  ): Observation | undefined {
    const doc = this.loadFresh(scope, projectPath);
    const idx = doc.observations.findIndex((o) => o.id === id);
    if (idx === -1) return undefined;
    const current = doc.observations[idx];
    if (!current) return undefined;
    if (current.deletedAt !== undefined) return undefined;
    const updated: Observation = {
      ...current,
      ...(pinned ? { pinned: true } : {}),
      updatedAt: Date.now(),
    };
    // When unpinning, drop the key entirely (exactOptionalPropertyTypes).
    if (!pinned) {
      const rest = { ...updated };
      delete rest.pinned;
      doc.observations[idx] = { ...rest, updatedAt: updated.updatedAt } as Observation;
    } else {
      doc.observations[idx] = updated;
    }
    this.save(doc);
    return doc.observations[idx];
  }

  softDelete(
    scope: MemoryScope,
    projectPath: string | undefined,
    id: string,
  ): boolean {
    const doc = this.loadFresh(scope, projectPath);
    const obs = doc.observations.find((o) => o.id === id);
    if (!obs || obs.deletedAt !== undefined) return false;
    obs.deletedAt = Date.now();
    obs.updatedAt = Date.now();
    this.save(doc);
    return true;
  }

  // ── Session mutations ────────────────────────────────────────────

  appendSession(
    input: Omit<MemorySession, 'id'> & { scope: MemoryScope; projectPath?: string },
  ): MemorySession {
    const { scope, projectPath, ...fields } = input;
    const doc = this.loadFresh(scope, projectPath);
    const id = `ses-${doc.nextSessionSeq}`;
    doc.nextSessionSeq += 1;
    const session: MemorySession = {
      id,
      project: fields.project,
      directory: fields.directory,
      startedAt: fields.startedAt,
      ...(fields.sessionId !== undefined && { sessionId: fields.sessionId }),
      ...(fields.endedAt !== undefined && { endedAt: fields.endedAt }),
      ...(fields.summary !== undefined && { summary: fields.summary }),
      ...(fields.auto !== undefined && { auto: fields.auto }),
      ...(fields.agentId !== undefined && { agentId: fields.agentId }),
      ...(fields.kind !== undefined && { kind: fields.kind }),
    };
    doc.sessions.push(session);
    this.enforceLimits(doc);
    this.save(doc);
    return session;
  }

  /**
   * Find-or-update a session by its external `sessionId` (E-DSK-13 #318), so a
   * real run/session maps to a SINGLE record across turns instead of accreting
   * a synthetic one per summary. Creates the record on first sight; afterwards
   * merges the provided fields (endedAt/summary/auto), preserving startedAt.
   */
  upsertSession(
    input: Omit<MemorySession, 'id'> & { scope: MemoryScope; projectPath?: string; sessionId: string },
  ): MemorySession {
    const { scope, projectPath } = input;
    const doc = this.loadFresh(scope, projectPath);
    // Handoff records (S-2 F2.2) are never merge targets: a run summary for the
    // same sessionId must not overwrite the handoff entry.
    const idx = doc.sessions.findIndex(
      (s) => s.sessionId === input.sessionId && s.kind !== 'handoff',
    );
    if (idx === -1) return this.appendSession(input);
    const current = doc.sessions[idx];
    if (!current) return this.appendSession(input);
    // The passive run-end auto-summary must never replace an agent-authored
    // mem_session_summary for the same session: the manual record is the rich
    // one (goal/decisions/next steps); the auto one is a one-line caption. The
    // inverse stays allowed — a manual summary upgrades an auto record.
    const preserveManualSummary =
      input.auto === true && current.summary !== undefined && current.auto !== true;
    const updated: MemorySession = {
      ...current,
      ...(input.endedAt !== undefined && { endedAt: input.endedAt }),
      ...(input.agentId !== undefined && { agentId: input.agentId }),
    };
    if (!preserveManualSummary) {
      if (input.summary !== undefined) {
        updated.summary = input.summary;
        // The flag describes the STORED summary's provenance: a manual write
        // must clear the auto flag a previous run's auto-capture left behind,
        // or the next run-end auto-summary would see auto:true and clobber it.
        if (input.auto === true) updated.auto = true;
        else delete updated.auto;
      } else if (input.auto !== undefined) {
        updated.auto = input.auto;
      }
    }
    doc.sessions[idx] = updated;
    this.save(doc);
    return updated;
  }

  // ── Prompt mutations ─────────────────────────────────────────────

  appendPrompt(
    input: Omit<UserPromptRecord, 'id'> & { scope: MemoryScope; projectPath?: string },
  ): UserPromptRecord {
    const { scope, projectPath, ...fields } = input;
    const doc = this.loadFresh(scope, projectPath);
    const id = `prm-${doc.nextPromptSeq}`;
    doc.nextPromptSeq += 1;
    const record: UserPromptRecord = {
      id,
      sessionId: fields.sessionId,
      content: fields.content,
      createdAt: fields.createdAt,
      ...(fields.project !== undefined && { project: fields.project }),
      ...(fields.agentId !== undefined && { agentId: fields.agentId }),
    };
    doc.prompts.push(record);
    this.enforceLimits(doc);
    this.save(doc);
    return record;
  }

  // ── Search ───────────────────────────────────────────────────────

  /**
   * Lexical search over active (non-deleted) observations.
   *
   * Scoring: each query token that appears in a field adds to the score.
   * Title matches are weighted 3×, content 1×, type/project/topicKey 1×.
   * Ties are broken by updatedAt descending (most recently updated first).
   */
  search(
    scope: MemoryScope,
    projectPath: string | undefined,
    q: MemorySearchQuery,
  ): MemorySearchHit[] {
    const doc = this.load(scope, projectPath);
    const tokens = tokenize(q.query);
    const limit = q.limit ?? 20;

    const active = doc.observations.filter((o) => {
      if (o.deletedAt !== undefined) return false;
      if (q.type !== undefined && o.type !== q.type) return false;
      if (q.project !== undefined && o.project !== q.project) return false;
      if (q.scope !== undefined && o.scope !== q.scope) return false;
      return true;
    });

    if (tokens.length === 0) {
      // Empty query: return most recently updated, respecting filters.
      return active
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, limit)
        .map((observation) => ({ observation, score: 0 }));
    }

    const hits: MemorySearchHit[] = active
      .map((obs) => ({ observation: obs, score: scoreObservation(obs, tokens) }))
      .filter((h) => h.score > 0)
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return b.observation.updatedAt - a.observation.updatedAt;
      })
      .slice(0, limit);

    return hits;
  }
}

// ── Scoring helpers ──────────────────────────────────────────────────

/** Extract the trailing monotonic sequence from an id like `obs-42` → 42. */
function seqOf(id: string): number {
  const m = /-(\d+)$/.exec(id);
  return m ? Number(m[1]) : 0;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 1);
}

function countMatches(text: string, tokens: string[]): number {
  const lower = text.toLowerCase();
  return tokens.reduce((acc, t) => acc + (lower.includes(t) ? 1 : 0), 0);
}

function scoreObservation(obs: Observation, tokens: string[]): number {
  const titleScore = countMatches(obs.title, tokens) * 3;
  const contentScore = countMatches(obs.content, tokens);
  const metaScore =
    countMatches(obs.type, tokens) +
    (obs.project ? countMatches(obs.project, tokens) : 0) +
    (obs.topicKey ? countMatches(obs.topicKey, tokens) : 0);
  return titleScore + contentScore + metaScore;
}

// ── Parsing / defaults ───────────────────────────────────────────────

export function freshDoc(scope: MemoryScope, projectPath?: string): MemoryStoreDoc {
  return {
    version: 1,
    scope,
    ...(projectPath !== undefined && { projectPath }),
    sessions: [],
    observations: [],
    prompts: [],
    nextObsSeq: 1,
    nextSessionSeq: 1,
    nextPromptSeq: 1,
  };
}

/**
 * Defensive parser. A corrupt file or version mismatch produces a fresh
 * document rather than crashing the store. Unknown fields are silently
 * dropped; missing arrays default to empty.
 */
export function parseDoc(
  raw: unknown,
  scope: MemoryScope,
  projectPath?: string,
): MemoryStoreDoc | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) return null;

  const observations = Array.isArray(r['observations'])
    ? (r['observations'] as unknown[]).flatMap((o) =>
        isObj(o) ? [normaliseObservation(o)] : [],
      )
    : [];

  const sessions = Array.isArray(r['sessions'])
    ? (r['sessions'] as unknown[]).flatMap((s) =>
        isObj(s) ? [normaliseSession(s)] : [],
      )
    : [];

  const prompts = Array.isArray(r['prompts'])
    ? (r['prompts'] as unknown[]).flatMap((p) =>
        isObj(p) ? [normalisePrompt(p)] : [],
      )
    : [];

  return {
    version: 1,
    scope: (r['scope'] as MemoryScope | undefined) ?? scope,
    ...(projectPath !== undefined && { projectPath }),
    observations,
    sessions,
    prompts,
    nextObsSeq:
      typeof r['nextObsSeq'] === 'number' ? r['nextObsSeq'] : observations.length + 1,
    nextSessionSeq:
      typeof r['nextSessionSeq'] === 'number'
        ? r['nextSessionSeq']
        : sessions.length + 1,
    nextPromptSeq:
      typeof r['nextPromptSeq'] === 'number'
        ? r['nextPromptSeq']
        : prompts.length + 1,
  };
}

const OBS_TYPES: ReadonlySet<string> = new Set([
  'decision', 'architecture', 'bugfix', 'pattern',
  'config', 'discovery', 'learning', 'manual',
]);

function toObsType(v: unknown): MemoryObservationType {
  return typeof v === 'string' && OBS_TYPES.has(v)
    ? (v as MemoryObservationType)
    : 'manual';
}

function toScope(v: unknown): MemoryScope {
  return v === 'project' ? 'project' : 'personal';
}

function normaliseObservation(o: Record<string, unknown>): Observation {
  return {
    id: String(o['id'] ?? ''),
    sessionId: String(o['sessionId'] ?? ''),
    type: toObsType(o['type']),
    title: String(o['title'] ?? ''),
    content: String(o['content'] ?? ''),
    scope: toScope(o['scope']),
    createdAt: typeof o['createdAt'] === 'number' ? o['createdAt'] : Date.now(),
    updatedAt: typeof o['updatedAt'] === 'number' ? o['updatedAt'] : Date.now(),
    ...(typeof o['syncId'] === 'string' && { syncId: o['syncId'] }),
    ...(typeof o['project'] === 'string' && { project: o['project'] }),
    ...(typeof o['topicKey'] === 'string' && { topicKey: o['topicKey'] }),
    ...(typeof o['toolName'] === 'string' && { toolName: o['toolName'] }),
    ...(typeof o['deletedAt'] === 'number' && { deletedAt: o['deletedAt'] }),
    ...(typeof o['pinned'] === 'boolean' && { pinned: o['pinned'] }),
    ...(typeof o['agentId'] === 'string' && { agentId: o['agentId'] }),
  };
}

function normaliseSession(s: Record<string, unknown>): MemorySession {
  return {
    id: String(s['id'] ?? ''),
    project: String(s['project'] ?? ''),
    directory: String(s['directory'] ?? ''),
    startedAt: typeof s['startedAt'] === 'number' ? s['startedAt'] : Date.now(),
    ...(typeof s['sessionId'] === 'string' && { sessionId: s['sessionId'] }),
    ...(typeof s['endedAt'] === 'number' && { endedAt: s['endedAt'] }),
    ...(typeof s['summary'] === 'string' && { summary: s['summary'] }),
    ...(typeof s['auto'] === 'boolean' && { auto: s['auto'] }),
    ...(typeof s['agentId'] === 'string' && { agentId: s['agentId'] }),
    ...(s['kind'] === 'handoff' && { kind: 'handoff' as const }),
  };
}

function normalisePrompt(p: Record<string, unknown>): UserPromptRecord {
  return {
    id: String(p['id'] ?? ''),
    sessionId: String(p['sessionId'] ?? ''),
    content: String(p['content'] ?? ''),
    createdAt: typeof p['createdAt'] === 'number' ? p['createdAt'] : Date.now(),
    ...(typeof p['project'] === 'string' && { project: p['project'] }),
    ...(typeof p['agentId'] === 'string' && { agentId: p['agentId'] }),
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}
