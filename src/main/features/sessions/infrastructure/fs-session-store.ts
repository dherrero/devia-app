import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { ConfigRepository, SessionStore } from '../../../shared/ports';
import type { PersistedSession } from '../../../../shared/domain/session';
import { parsePersistedSession } from '../../../../shared/domain/session';
import type { SessionStats, StatsSourceMessage } from '../../../../shared/domain/session-stats';
import { buildSessionStats } from '../../../../shared/domain/session-stats';
import { projectKey } from '../../../shared/project-key';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Layout (mirrors `~/.claude/projects`):
 *
 *   ~/.devia-app/projects/
 *     -home-dherr-repos-myApp/
 *       session-<uuid>.json
 *
 * The directory name is the project's absolute path with `/` → `-`.
 * Each session = one JSON file with id, timestamps and message array. The
 * renderer is the source of truth for the messages; main writes what's
 * pushed via IPC and loads on demand.
 */
export class FsSessionStore implements SessionStore {
  constructor(private readonly config: ConfigRepository) {}

  private projectsRoot(): string {
    const dir = path.join(this.config.deviaDir(), 'projects');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private projectDir(projectPath: string): string | null {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return null;
    // path.resolve normalises trailing slashes, mixed separators, and `.` / `..`
    // so the directory key is always the same regardless of how the caller
    // constructed the path string.
    const abs = path.resolve(workspaceRoot, projectPath);
    const dir = path.join(this.projectsRoot(), projectKey(abs));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private sessionFile(projectPath: string, sessionId: string): string | null {
    const dir = this.projectDir(projectPath);
    return dir ? path.join(dir, `session-${sessionId}.json`) : null;
  }

  newSessionId(): string {
    return crypto.randomUUID();
  }

  isValidSessionId(id: string | null | undefined): id is string {
    return typeof id === 'string' && UUID_RE.test(id);
  }

  save(projectPath: string, session: PersistedSession): void {
    const file = this.sessionFile(projectPath, session.id);
    if (!file) return;
    if (parsePersistedSession(session) === null) {
      throw new Error(`Invalid PersistedSession: missing required fields on session "${session.id}"`);
    }
    try {
      fs.writeFileSync(file, JSON.stringify(session, null, 2));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[sessions] save failed:', message);
    }
  }

  load(projectPath: string, sessionId: string): PersistedSession | null {
    const file = this.sessionFile(projectPath, sessionId);
    if (!file || !fs.existsSync(file)) return null;
    try {
      const parsed = parsePersistedSession(JSON.parse(fs.readFileSync(file, 'utf8')));
      if (parsed === null) {
        console.warn(`[sessions] skipping malformed session file: ${file}`);
      }
      return parsed;
    } catch {
      return null;
    }
  }

  list(projectPath: string): PersistedSession[] {
    const dir = this.projectDir(projectPath);
    if (!dir) return [];
    try {
      return fs.readdirSync(dir)
        .filter((f) => f.startsWith('session-') && f.endsWith('.json'))
        .map((f): PersistedSession | null => {
          try {
            return parsePersistedSession(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
          } catch {
            return null;
          }
        })
        .filter((s): s is PersistedSession => s !== null)
        .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    } catch {
      return [];
    }
  }

  deleteOne(projectPath: string, sessionId: string): void {
    const file = this.sessionFile(projectPath, sessionId);
    if (!file) return;
    try { fs.unlinkSync(file); } catch { /* swallow */ }
  }

  deleteProjectSessions(projectPath: string): void {
    const dir = this.projectDir(projectPath);
    if (!dir) return;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* swallow */ }
  }

  collectAllStats(): SessionStats[] {
    const root = this.projectsRoot();
    const out: SessionStats[] = [];
    let projectDirs: string[];
    try { projectDirs = fs.readdirSync(root); } catch { return out; }
    for (const name of projectDirs) {
      const dir = path.join(root, name);
      let files: string[];
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        files = fs.readdirSync(dir).filter((f) => f.startsWith('session-') && f.endsWith('.json'));
      } catch { continue; }
      for (const f of files) {
        try {
          const session = parsePersistedSession(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')));
          if (!session) continue;
          if (session.stats) {
            out.push(session.stats);
          } else if (session.messages.length > 0) {
            out.push(buildSessionStats({
              messages: session.messages as StatsSourceMessage[],
              fallbackAgentId: 'unknown',
              now: session.updatedAt,
            }));
          }
        } catch { /* skip malformed file */ }
      }
    }
    return out;
  }
}
