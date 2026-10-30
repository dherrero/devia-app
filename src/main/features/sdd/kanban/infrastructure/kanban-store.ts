import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
  BlockReason,
  KanbanBoard,
  KanbanBoardView,
  KanbanCardView,
  KanbanColumn,
  KanbanListCard,
  KanbanListOptions,
  KanbanListResult,
  KanbanSpec,
  KanbanSpecSummary,
  KanbanTask,
  KanbanTaskView,
} from '../../../../../shared/domain/kanban';
import { KANBAN_COLUMNS } from '../../../../../shared/domain/kanban';

const DEFAULT_LIST_LIMIT = 30;

/**
 * JSON-backed per-project kanban store (E-DSK-12, Phase A).
 *
 * One document per project at
 * `<deviaDir>/projects/<key>/kanban.json`, written atomically
 * (temp + rename). The `<key>` mirrors the existing project cache key
 * convention used by sessions/state.
 *
 * In-memory cache per project so back-to-back reads (UI render +
 * MCP tool call) don't re-parse the file. Every mutation goes
 * through `save()` which refreshes the cache and writes to disk.
 */
export class KanbanStore {
  private readonly cache = new Map<string, KanbanBoard>();

  constructor(private readonly deviaDir: () => string) {}

  /** Cache key derived from the absolute project path, matching the
   *  scheme other features use (replace non-alphanumerics). */
  static keyForPath(projectPath: string): string {
    return projectPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  }

  private file(projectPath: string): string {
    return path.join(
      this.deviaDir(), 'projects', KanbanStore.keyForPath(projectPath), 'kanban.json',
    );
  }

  load(projectPath: string): KanbanBoard {
    const cached = this.cache.get(projectPath);
    if (cached) return cached;
    let board: KanbanBoard | null = null;
    try {
      const raw = fs.readFileSync(this.file(projectPath), 'utf8');
      board = parseBoard(JSON.parse(raw), projectPath);
    } catch {
      board = null;
    }
    const result = board ?? freshBoard(projectPath);
    this.cache.set(projectPath, result);
    return result;
  }

  save(board: KanbanBoard): void {
    this.cache.set(board.projectPath, board);
    const file = this.file(board.projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(board, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  }

  /** Drop the in-memory copy so the next `load()` re-reads from disk.
   *  Used when the out-of-process MCP server (T5) mutated the file. */
  invalidate(projectPath: string): void {
    this.cache.delete(projectPath);
  }

  /** Absolute path of a project's board file (for fs.watch wiring). */
  fileFor(projectPath: string): string {
    return this.file(projectPath);
  }

  // ── views ───────────────────────────────────────────────────────

  /**
   * Full board snapshot for the renderer. Archived specs (and their
   * tasks) are omitted by default so the UI never shows closed work;
   * pass `{ includeArchived: true }` to get everything.
   */
  boardView(projectPath: string, opts: { includeArchived?: boolean } = {}): KanbanBoardView {
    const board = this.load(projectPath);
    const archived = new Set(
      board.specs.filter((s) => s.archivedAt !== undefined).map((s) => s.id),
    );
    const showArchived = opts.includeArchived === true;
    return {
      projectPath,
      specs: board.specs
        .filter((s) => showArchived || !archived.has(s.id))
        .map((s) => ({ ...s })),
      tasks: board.tasks
        .filter((t) => showArchived || !archived.has(t.specId))
        .slice()
        .sort((a, b) => a.sortIndex - b.sortIndex)
        .map(toCardView),
    };
  }

  taskView(projectPath: string, taskId: string): KanbanTaskView | null {
    const task = this.load(projectPath).tasks.find((t) => t.id === taskId);
    return task ? toTaskView(task) : null;
  }

  /**
   * Lightweight spec summaries (id + title + per-column task counts).
   * The cheap answer to "what specs exist?" — no task bodies, no
   * threads. Archived specs are excluded unless `includeArchived`.
   */
  specSummaries(
    projectPath: string,
    opts: { includeArchived?: boolean } = {},
  ): KanbanSpecSummary[] {
    const board = this.load(projectPath);
    const showArchived = opts.includeArchived === true;
    return board.specs
      .filter((s) => showArchived || s.archivedAt === undefined)
      .map((s) => toSpecSummary(s, board.tasks));
  }

  /**
   * Paginated, filtered board listing for the `kanban_list` tool. Returns
   * spec summaries plus a page of task cards (lightweight by default,
   * `verbose` adds the body). Filters: `specId`, `column`, and archived
   * exclusion. `total`/`hasMore` let the caller page on demand instead of
   * dumping the whole board.
   */
  listBoard(projectPath: string, opts: KanbanListOptions = {}): KanbanListResult {
    const board = this.load(projectPath);
    const showArchived = opts.includeArchived === true;
    const archived = new Set(
      board.specs.filter((s) => s.archivedAt !== undefined).map((s) => s.id),
    );

    const filtered = board.tasks
      .filter((t) => showArchived || !archived.has(t.specId))
      .filter((t) => opts.specId === undefined || t.specId === opts.specId)
      .filter((t) => opts.column === undefined || t.column === opts.column)
      .slice()
      .sort((a, b) => a.sortIndex - b.sortIndex);

    const total = filtered.length;
    const offset = Math.max(0, opts.offset ?? 0);
    const limit = Math.max(1, opts.limit ?? DEFAULT_LIST_LIMIT);
    const page = filtered.slice(offset, offset + limit);
    const tasks: KanbanListCard[] = page.map((t) =>
      opts.verbose ? { ...toCardView(t), body: t.body } : toCardView(t),
    );

    return {
      specs: board.specs
        .filter((s) => showArchived || s.archivedAt === undefined)
        .filter((s) => opts.specId === undefined || s.id === opts.specId)
        .map((s) => toSpecSummary(s, board.tasks)),
      tasks,
      total,
      offset,
      limit,
      hasMore: offset + page.length < total,
    };
  }
}

// ─── mapping ──────────────────────────────────────────────────────

function toCardView(t: KanbanTask): KanbanCardView {
  return {
    id: t.id,
    specId: t.specId,
    title: t.title,
    column: t.column,
    ...(t.blockReason !== undefined && { blockReason: t.blockReason }),
    dependsOn: t.dependsOn,
    sortIndex: t.sortIndex,
    ...(t.dueDate !== undefined && { dueDate: t.dueDate }),
    unreadCount: t.thread.filter((m) => !m.read).length,
    subagentNames: Array.from(new Set(t.subagentLog.map((s) => s.subagentName))),
    hasCommit: !!t.closingCommit || t.linkedCommits.length > 0,
  };
}

function toSpecSummary(s: KanbanSpec, tasks: KanbanTask[]): KanbanSpecSummary {
  const taskCounts = Object.fromEntries(
    KANBAN_COLUMNS.map((c) => [c, 0]),
  ) as Record<KanbanColumn, number>;
  let totalTasks = 0;
  for (const t of tasks) {
    if (t.specId !== s.id) continue;
    taskCounts[t.column] += 1;
    totalTasks += 1;
  }
  return {
    id: s.id,
    title: s.title,
    archived: s.archivedAt !== undefined,
    taskCounts,
    totalTasks,
  };
}

function toTaskView(t: KanbanTask): KanbanTaskView {
  return {
    id: t.id,
    specId: t.specId,
    title: t.title,
    body: t.body,
    column: t.column,
    ...(t.blockReason !== undefined && { blockReason: t.blockReason }),
    ...(t.blockTarget !== undefined && { blockTarget: t.blockTarget }),
    dependsOn: t.dependsOn,
    ...(t.dueDate !== undefined && { dueDate: t.dueDate }),
    thread: t.thread,
    subagentLog: t.subagentLog,
    ...(t.closingCommit !== undefined && { closingCommit: t.closingCommit }),
    linkedCommits: t.linkedCommits,
  };
}

// ─── parsing / defaults ───────────────────────────────────────────

function freshBoard(projectPath: string): KanbanBoard {
  return {
    version: 1,
    projectPath,
    specs: [],
    tasks: [],
    nextSpecSeq: 1,
    nextTaskSeq: 1,
  };
}

/**
 * Defensive parser — a hand-edited / corrupt file collapses to a
 * fresh board rather than crashing the store. We keep it permissive:
 * unknown fields are dropped, missing arrays default to empty.
 */
function parseBoard(raw: unknown, projectPath: string): KanbanBoard {
  if (raw === null || typeof raw !== 'object') return freshBoard(projectPath);
  const r = raw as Record<string, unknown>;
  if (r['version'] !== 1) return freshBoard(projectPath);

  const specs = Array.isArray(r['specs'])
    ? (r['specs'] as unknown[]).flatMap((s) => (isObj(s) ? [normaliseSpec(s)] : []))
    : [];
  const tasks = Array.isArray(r['tasks'])
    ? (r['tasks'] as unknown[]).flatMap((t) => (isObj(t) ? [normaliseTask(t as Record<string, unknown>)] : []))
    : [];

  return {
    version: 1,
    projectPath,
    specs,
    tasks,
    nextSpecSeq: typeof r['nextSpecSeq'] === 'number' ? r['nextSpecSeq'] : specs.length + 1,
    nextTaskSeq: typeof r['nextTaskSeq'] === 'number' ? r['nextTaskSeq'] : tasks.length + 1,
  };
}

function normaliseSpec(s: Record<string, unknown>): KanbanSpec {
  return {
    id: String(s['id'] ?? ''),
    title: String(s['title'] ?? ''),
    description: String(s['description'] ?? ''),
    createdAt: typeof s['createdAt'] === 'number' ? s['createdAt'] : Date.now(),
    ...(typeof s['archivedAt'] === 'number' && { archivedAt: s['archivedAt'] }),
  };
}

function normaliseTask(t: Record<string, unknown>): KanbanTask {
  return {
    id: String(t['id'] ?? ''),
    specId: String(t['specId'] ?? ''),
    title: String(t['title'] ?? ''),
    body: String(t['body'] ?? ''),
    column: (t['column'] as KanbanTask['column']) ?? 'backlog',
    ...(typeof t['previousColumn'] === 'string' && { previousColumn: t['previousColumn'] as KanbanColumn }),
    ...(typeof t['blockReason'] === 'string' && { blockReason: t['blockReason'] as BlockReason }),
    ...(typeof t['blockTarget'] === 'string' && { blockTarget: t['blockTarget'] as string }),
    dependsOn: Array.isArray(t['dependsOn']) ? (t['dependsOn'] as unknown[]).map(String) : [],
    sortIndex: typeof t['sortIndex'] === 'number' ? t['sortIndex'] : 0,
    ...(typeof t['dueDate'] === 'string' && { dueDate: t['dueDate'] as string }),
    ...(typeof t['closingCommit'] === 'string' && { closingCommit: t['closingCommit'] as string }),
    linkedCommits: Array.isArray(t['linkedCommits']) ? (t['linkedCommits'] as unknown[]).map(String) : [],
    thread: Array.isArray(t['thread']) ? (t['thread'] as KanbanTask['thread']) : [],
    subagentLog: Array.isArray(t['subagentLog']) ? (t['subagentLog'] as KanbanTask['subagentLog']) : [],
    createdAt: typeof t['createdAt'] === 'number' ? t['createdAt'] : Date.now(),
    updatedAt: typeof t['updatedAt'] === 'number' ? t['updatedAt'] : Date.now(),
  };
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object';
}
