import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionTranscriptRef } from '../../../../shared/domain/agent-transcript';
import type { SessionTranscriptReader } from '../domain/ports';

/**
 * Reads grok-dev sessions from its SQLite store (`~/.grok/grok.db`).
 *
 * Driver: Node's built-in `node:sqlite` (`DatabaseSync`), loaded lazily and
 * defensively so the feature degrades gracefully where it isn't available
 * (older Node without the experimental flag) — `available()` returns false and
 * grok simply doesn't appear in the import wizard, never crashing. No native
 * dependency is added (grok-dev's own `bun:sqlite` can't be used from Electron).
 *
 * The store has many sessions in one file, so a `SessionTranscriptRef.filePath`
 * carries the SESSION ID (not the db path); `read()` re-opens the db read-only,
 * joins `sessions` + ordered `messages`, and serialises the aggregate to JSON
 * for the pure `parseGrokTranscript`.
 */

interface SqliteRow { [k: string]: unknown }
interface DatabaseSyncLike {
  prepare(sql: string): { all(...params: unknown[]): SqliteRow[]; get(...params: unknown[]): SqliteRow | undefined };
  close(): void;
}
type SqliteModule = { DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => DatabaseSyncLike };

let cachedSqlite: SqliteModule | null | undefined;
function loadSqlite(): SqliteModule | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    cachedSqlite = require('node:sqlite') as SqliteModule;
  } catch {
    cachedSqlite = null;
  }
  return cachedSqlite;
}

export class FsGrokSessionsReader implements SessionTranscriptReader {
  readonly agentId = 'grok';

  private dbPath(): string {
    const base = process.env['GROK_HOME']?.trim() || path.join(os.homedir(), '.grok');
    return path.join(base, 'grok.db');
  }

  available(): boolean {
    if (loadSqlite() === null) return false;
    try {
      return fs.statSync(this.dbPath()).isFile();
    } catch {
      return false;
    }
  }

  private open(): DatabaseSyncLike | null {
    const sqlite = loadSqlite();
    if (!sqlite) return null;
    try {
      return new sqlite.DatabaseSync(this.dbPath(), { readOnly: true });
    } catch {
      return null;
    }
  }

  listTranscripts(): SessionTranscriptRef[] {
    const db = this.open();
    if (!db) return [];
    try {
      const rows = db.prepare('SELECT id FROM sessions').all();
      const out: SessionTranscriptRef[] = [];
      for (const r of rows) {
        if (typeof r['id'] === 'string' && r['id']) out.push({ nativeId: r['id'], filePath: r['id'] });
      }
      return out;
    } catch {
      return [];
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }

  /** `filePath` is the session id (see class doc). Returns the serialised
   *  aggregate `{ session, messages }` JSON, or null on any error. */
  read(filePath: string): string | null {
    const db = this.open();
    if (!db) return null;
    try {
      const session = db
        .prepare('SELECT id, title, cwd_at_start, cwd_last, created_at, updated_at FROM sessions WHERE id = ?')
        .get(filePath);
      if (!session) return null;
      const messages = db
        .prepare('SELECT seq, role, message_json FROM messages WHERE session_id = ? ORDER BY seq ASC')
        .all(filePath);
      return JSON.stringify({
        session: {
          id: session['id'],
          title: session['title'],
          cwdAtStart: session['cwd_at_start'],
          cwdLast: session['cwd_last'],
          createdAt: session['created_at'],
          updatedAt: session['updated_at'],
        },
        messages: messages.map((m) => ({ seq: m['seq'], role: m['role'], messageJson: m['message_json'] })),
      });
    } catch {
      return null;
    } finally {
      try { db.close(); } catch { /* ignore */ }
    }
  }
}
