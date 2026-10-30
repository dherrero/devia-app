import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionTranscriptRef } from '../../../../shared/domain/agent-transcript';
import type { SessionTranscriptReader } from '../domain/ports';

/** `rollout-<ts>-<uuid>.jsonl` — the uuid is Codex's resumable conversation id. */
const ROLLOUT_RE = /^rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Skip pathologically large transcripts to bound memory on import. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
/** sessions/YYYY/MM/DD/rollout-*.jsonl — cap recursion so a crafted tree can't
 *  walk forever. */
const MAX_DEPTH = 5;

/**
 * Reads OpenAI Codex rollout transcripts from `<codex-home>/sessions/`.
 * `<codex-home>` is `CODEX_HOME` when set, else `~/.codex`.
 */
export class FsCodexSessionsReader implements SessionTranscriptReader {
  readonly agentId = 'codex';

  private sessionsDir(): string {
    const base = process.env['CODEX_HOME']?.trim() || path.join(os.homedir(), '.codex');
    return path.join(base, 'sessions');
  }

  available(): boolean {
    try {
      return fs.statSync(this.sessionsDir()).isDirectory();
    } catch {
      return false;
    }
  }

  listTranscripts(): SessionTranscriptRef[] {
    const out: SessionTranscriptRef[] = [];
    this.walk(this.sessionsDir(), 0, out);
    return out;
  }

  private walk(dir: string, depth: number, out: SessionTranscriptRef[]): void {
    if (depth > MAX_DEPTH) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // lstat guard: never follow a symlinked dir or file into another tree.
      if (entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.walk(full, depth + 1, out);
      } else if (entry.isFile()) {
        const match = ROLLOUT_RE.exec(entry.name);
        const nativeId = match?.[1];
        if (nativeId) out.push({ nativeId, filePath: full });
      }
    }
  }

  read(filePath: string): string | null {
    try {
      const stat = fs.statSync(filePath);
      if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      return null;
    }
  }
}
