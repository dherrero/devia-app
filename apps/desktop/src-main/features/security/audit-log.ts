import * as fs from 'fs';
import * as path from 'path';
import type { RunId } from '../../../shared/domain/agent';
import type { RunMode } from '../../../shared/domain/run-capabilities';

/**
 * A single audit log entry. Intentionally minimal: timestamp, agent identity,
 * project path, and tool name only. No prompt text, no tool inputs — preserving
 * user privacy while still providing operational visibility.
 *
 * TR-3: entries are persisted as JSONL (one JSON object per line).
 */
export interface AuditEntry {
  ts: number;
  agentId: string;
  project: string;
  tool: string;
  summary?: string;
  /**
   * Run identifier (REV-AGENT-CORE-001). Optional for back-compat with audit
   * log files written before runId support was added.
   */
  runId?: RunId;
  /**
   * Run mode (REV-AGENT-CORE-005). Captures the permission policy that was in
   * effect when this tool ran. Optional for back-compat with pre-005 entries.
   */
  mode?: RunMode;
}

export interface AgentAuditLog {
  /**
   * Append one audit entry. Must be fire-and-forget: this method must NEVER
   * throw. Failures are silently swallowed so a log write failure cannot crash
   * the main process or interrupt a running agent.  (TR-2)
   */
  append(entry: AuditEntry): void;

  /**
   * Return the last `n` entries in order (oldest first within the returned
   * window). Never throws — returns [] on any read error.
   */
  readLast(n: number): AuditEntry[];
}

/** Threshold for log rotation: 1 MiB. (TR-4) */
const ROTATION_THRESHOLD = 1_048_576;

function isValidEntry(v: unknown): v is AuditEntry {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o['ts'] === 'number' &&
    typeof o['agentId'] === 'string' &&
    typeof o['project'] === 'string' &&
    typeof o['tool'] === 'string'
  );
}

/** Retention window for rotated backup files. */
const ROTATION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/**
 * Production implementation: appends JSONL lines to a file in `<userData>/`.
 *
 * Security guarantees:
 *  - File permissions are set to 0o600 (owner read/write only) on POSIX after
 *    the first write, so other OS users cannot read audit entries. Skipped on
 *    Windows (0o600 has no effect there; NTFS ACLs apply).
 *  - Entries contain only tool names and project paths — never prompt text or
 *    tool inputs.
 *
 * Rotation (TR-4 / UC-FIX-014):
 *  - Before each append: if the file is >= 1 MiB, rename `audit.log` →
 *    `audit.log.<isoTs>.jsonl` (timestamped so consecutive rotations never
 *    overwrite each other). Old backups older than 30 days are swept up.
 */
export class FileAgentAuditLog implements AgentAuditLog {
  private permissionsApplied = false;

  constructor(private readonly auditPath: string) {}

  append(entry: AuditEntry): void {
    try {
      this.maybeRotate();
      const line = JSON.stringify(entry) + '\n';
      fs.appendFileSync(this.auditPath, line, 'utf-8');
      this.maybeApplyPermissions();
    } catch (err) {
      // TR-2: fire-and-forget — never throw from a log write.
      console.warn('[audit-log] write failed:', err instanceof Error ? err.message : String(err));
    }
  }

  readLast(n: number): AuditEntry[] {
    try {
      const raw = fs.readFileSync(this.auditPath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .slice(-n)
        .map((line) => {
          try { return JSON.parse(line) as unknown; } catch { return null; }
        })
        .filter(isValidEntry);
    } catch {
      return [];
    }
  }

  private maybeRotate(): void {
    try {
      const stat = fs.statSync(this.auditPath);
      if (stat.size < ROTATION_THRESHOLD) return;
      // UC-FIX-014: timestamp with millisecond precision plus a collision
      // suffix, so two rotations within the same millisecond never overwrite
      // each other. Format: YYYYMMDDTHHmmssSSSZ[-n] (lexicographically sortable).
      const ts = new Date().toISOString().replace(/[-:]/g, '').replace('.', '');
      let backup = `${this.auditPath}.${ts}.jsonl`;
      for (let n = 1; fs.existsSync(backup); n++) {
        backup = `${this.auditPath}.${ts}-${n}.jsonl`;
      }
      fs.renameSync(this.auditPath, backup);
      // Reset flag so permissions are re-applied to the new file.
      this.permissionsApplied = false;
      this.sweepOldBackups();
    } catch {
      // File doesn't exist yet, or stat failed — both are fine.
    }
  }

  private sweepOldBackups(): void {
    const dir = path.dirname(this.auditPath);
    const base = path.basename(this.auditPath);
    try {
      const cutoff = Date.now() - ROTATION_RETENTION_MS;
      const entries = fs.readdirSync(dir);
      for (const name of entries) {
        if (!name.startsWith(base + '.')) continue;
        const full = path.join(dir, name);
        try {
          const mtime = fs.statSync(full).mtime.getTime();
          if (mtime < cutoff) fs.unlinkSync(full);
        } catch { /* best-effort — locked or gone */ }
      }
    } catch { /* swallow — dir may not exist */ }
  }

  private maybeApplyPermissions(): void {
    if (this.permissionsApplied) return;
    if (process.platform === 'win32') {
      // NTFS manages access control separately; chmod is a no-op on Windows.
      this.permissionsApplied = true;
      return;
    }
    try {
      fs.chmodSync(this.auditPath, 0o600);
      this.permissionsApplied = true;
    } catch (err) {
      console.warn('[audit-log] chmod failed:', err instanceof Error ? err.message : String(err));
    }
  }
}

/**
 * Null object implementation — used in tests and as a composition fallback
 * when the audit log feature is disabled.
 */
export class NullAuditLog implements AgentAuditLog {
  append(entry: AuditEntry): void { void entry; }
  readLast(n: number): AuditEntry[] { void n; return []; }
}
