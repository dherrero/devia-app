import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionTranscriptRef } from '../../../../shared/domain/agent-transcript';
import type { SessionTranscriptReader } from '../domain/ports';

const UUID_JSONL_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;
/** Skip pathologically large transcripts to bound memory on import. */
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;

/**
 * Reads Claude Code transcripts from `<claude-config>/projects/`.
 * `<claude-config>` is `CLAUDE_CONFIG_DIR` when set, else `~/.claude`
 * (cross-platform via `os.homedir()`).
 */
export class FsClaudeProjectsReader implements SessionTranscriptReader {
  readonly agentId = 'claude';

  private projectsDir(): string {
    const base = process.env['CLAUDE_CONFIG_DIR']?.trim() || path.join(os.homedir(), '.claude');
    return path.join(base, 'projects');
  }

  available(): boolean {
    try {
      return fs.statSync(this.projectsDir()).isDirectory();
    } catch {
      return false;
    }
  }

  listTranscripts(): SessionTranscriptRef[] {
    const root = this.projectsDir();
    const out: SessionTranscriptRef[] = [];
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const dir of dirs) {
      // Skip symlinked project dirs (lstat guard, consistent with the
      // prompt-pack scanner) so a crafted link can't redirect the read.
      if (!dir.isDirectory() || dir.isSymbolicLink()) continue;
      const projectDir = path.join(root, dir.name);
      let files: fs.Dirent[];
      try {
        files = fs.readdirSync(projectDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        // Only top-level <uuid>.jsonl — `subagents/` lives in a subdir and is
        // excluded by the isFile() check (it's a directory).
        if (!file.isFile() || file.isSymbolicLink()) continue;
        const match = UUID_JSONL_RE.exec(file.name);
        const nativeId = match?.[1];
        if (!nativeId) continue;
        out.push({ nativeId, filePath: path.join(projectDir, file.name) });
      }
    }
    return out;
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
