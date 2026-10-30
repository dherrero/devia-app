import * as os from 'node:os';
import * as path from 'node:path';

import type {
  ImportEngramError,
  ImportEngramResult,
  ImportEngramSuccess,
  MemoryObservationType,
} from '../../../../shared/domain/memory';
import { MemoryStore } from '../infrastructure/memory-store';

// Re-export result types from shared so callers can import from either location.
export type { ImportEngramError, ImportEngramResult, ImportEngramSuccess };

// ── engram export document shape ──────────────────────────────────────────

/** Raw shape produced by `engram export <file>`. */
interface EngramExportDoc {
  version: string;
  exported_at: string;
  sessions: EngramSession[];
  observations: EngramObservation[];
  prompts: EngramPrompt[];
}

interface EngramSession {
  id: number;
  project: string;
  directory: string;
  started_at: string;
  ended_at?: string | null;
  summary?: string | null;
}

interface EngramObservation {
  id: number;
  sync_id: string;
  session_id: string;
  type: string;
  title: string;
  content: string;
  tool_name?: string | null;
  project?: string | null;
  scope: string;
  topic_key?: string | null;
  revision_count: number;
  duplicate_count: number;
  last_seen_at?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
}

interface EngramPrompt {
  id: number;
  sync_id: string;
  session_id: string;
  content: string;
  project?: string | null;
  created_at: string;
}

// ── injectable dependency types ───────────────────────────────────────────

/**
 * Async command runner for `engram export <file>`.
 * Returns stdout on success, throws on non-zero exit or timeout.
 */
export interface ExportRunner {
  run(binPath: string, args: string[], timeoutMs: number): Promise<void>;
}

/** Read a file from disk (injectable for testing). */
export interface FileFns {
  readUtf8(filePath: string): string;
  writeUtf8(filePath: string, content: string): void;
  deleteFile(filePath: string): void;
  makeTempPath(suffix: string): string;
}

/** Callback invoked after a successful import to record the import timestamp. */
export type MarkImportedFn = (at: number) => void;

// Result types now live in shared/domain/memory.ts and are re-exported at the
// top of this file; the local copies were removed to avoid a duplicate export.

// ── timestamp helper (pure, as specified in the spike doc) ────────────────

/**
 * Parse a SQLite UTC datetime string ("2026-05-24 10:30:00") to epoch ms.
 * Returns `Date.now()` for null/empty/unparseable input.
 */
export function parseSqliteTimestamp(raw: string | null | undefined): number {
  if (!raw) return Date.now();
  // SQLite uses a space separator; Date.parse needs 'T'.
  const iso = raw.replace(' ', 'T') + 'Z';
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? Date.now() : ms;
}

// ── type guards / coercions ───────────────────────────────────────────────

const OBS_TYPES: ReadonlySet<string> = new Set([
  'decision', 'architecture', 'bugfix', 'pattern',
  'config', 'discovery', 'learning', 'manual',
]);

function toObsType(v: string): MemoryObservationType {
  return OBS_TYPES.has(v) ? (v as MemoryObservationType) : 'manual';
}

// ── production file helpers ───────────────────────────────────────────────

/** Production implementation using Node.js fs. */
export function makeNodeFileFns(): FileFns {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  return {
    readUtf8(p) { return fs.readFileSync(p, 'utf8'); },
    writeUtf8(p, c) { fs.writeFileSync(p, c, 'utf8'); },
    deleteFile(p) { try { fs.unlinkSync(p); } catch { /* already gone */ } },
    makeTempPath(suffix) {
      return path.join(os.tmpdir(), `engram-export-${Date.now()}${suffix}`);
    },
  };
}

// ── use case ──────────────────────────────────────────────────────────────

/**
 * Import engram data into Devia's personal memory store.
 *
 * All engram data lands in `scope: 'personal'` (no projectPath) because
 * engram's project/directory strings may not match Devia's project keys.
 * See spike doc §9 "Import target scope".
 *
 * Idempotency: observations with an existing `syncId` in the personal store
 * are skipped — the import can safely be re-run without duplicating data.
 * Note: the spike doc §10 says de-dup by syncId is NOT required for phase 1,
 * but T-10 explicitly requires it ("if already exists with same syncId → skip").
 * We implement it here.
 */
export class ImportEngramUseCase {
  private static readonly EXPORT_TIMEOUT_MS = 30_000;

  constructor(
    private readonly runner: ExportRunner,
    private readonly store: MemoryStore,
    private readonly fileFns: FileFns,
    private readonly markImported: MarkImportedFn,
  ) {}

  async execute(binPath: string | undefined): Promise<ImportEngramResult> {
    if (!binPath) {
      return { ok: false, reason: 'engram-binary-missing' };
    }

    const tmpFile = this.fileFns.makeTempPath('.json');

    try {
      // Run `engram export <tmpFile>`.
      try {
        await this.runner.run(binPath, ['export', tmpFile], ImportEngramUseCase.EXPORT_TIMEOUT_MS);
      } catch (err) {
        const msg = String((err as Error).message ?? '');
        if (msg.includes('timeout') || msg.includes('timed out')) {
          return { ok: false, reason: 'engram-export-timeout' };
        }
        return { ok: false, reason: 'engram-export-failed', stderr: msg };
      }

      // Parse the export file.
      let doc: EngramExportDoc;
      try {
        const raw = this.fileFns.readUtf8(tmpFile);
        doc = JSON.parse(raw) as EngramExportDoc;
      } catch (err) {
        return {
          ok: false,
          reason: 'engram-parse-error',
          message: String((err as Error).message ?? 'unknown parse error'),
        };
      }

      // Validate minimum shape.
      if (!doc || !Array.isArray(doc.observations)) {
        return { ok: false, reason: 'engram-parse-error', message: 'missing observations array' };
      }

      // Collect existing syncIds to enable idempotent re-import.
      const personalDoc = this.store.load('personal');
      const existingSyncIds = new Set(
        personalDoc.observations
          .filter((o) => typeof o.syncId === 'string')
          .map((o) => o.syncId as string),
      );

      // Filter out soft-deleted observations (as per §5 of the spike doc).
      const activeObs = (doc.observations ?? []).filter(
        (o) => o.deleted_at == null || o.deleted_at === '',
      );

      let imported = 0;
      let skipped = 0;

      for (const o of activeObs) {
        if (existingSyncIds.has(o.sync_id)) {
          skipped += 1;
          continue;
        }

        this.store.appendObservation({
          syncId: o.sync_id,
          sessionId: String(o.session_id),
          type: toObsType(o.type),
          title: o.title,
          content: o.content,
          scope: 'personal',
          // Preserve the original scope value for cross-reference, but
          // all engram data lands in the personal store (§9).
          ...(o.project != null && { project: o.project }),
          ...(o.topic_key != null && { topicKey: o.topic_key }),
          ...(o.tool_name != null && { toolName: o.tool_name }),
        });

        // Patch the timestamps that appendObservation set to Date.now():
        // we want to preserve the engram originals.
        const savedDoc = this.store.load('personal');
        const savedObs = savedDoc.observations.find((x) => x.syncId === o.sync_id);
        if (savedObs) {
          (savedObs as { createdAt: number }).createdAt = parseSqliteTimestamp(o.created_at);
          (savedObs as { updatedAt: number }).updatedAt = parseSqliteTimestamp(o.updated_at);
          this.store.save(savedDoc);
        }

        existingSyncIds.add(o.sync_id);
        imported += 1;
      }

      // Import sessions.
      let sessionCount = 0;
      for (const s of doc.sessions ?? []) {
        this.store.appendSession({
          scope: 'personal',
          project: s.project ?? '',
          directory: s.directory ?? '',
          startedAt: parseSqliteTimestamp(s.started_at),
          ...(s.ended_at != null && { endedAt: parseSqliteTimestamp(s.ended_at) }),
          ...(s.summary != null && { summary: s.summary }),
        });
        sessionCount += 1;
      }

      // Import prompts.
      let promptCount = 0;
      for (const p of doc.prompts ?? []) {
        this.store.appendPrompt({
          scope: 'personal',
          sessionId: String(p.session_id),
          content: p.content,
          createdAt: parseSqliteTimestamp(p.created_at),
          ...(p.project != null && { project: p.project }),
        });
        promptCount += 1;
      }

      this.markImported(Date.now());

      return {
        ok: true,
        imported,
        skipped,
        sessions: sessionCount,
        prompts: promptCount,
      };
    } finally {
      this.fileFns.deleteFile(tmpFile);
    }
  }
}
