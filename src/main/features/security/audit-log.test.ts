/**
 * REV-TS-CLI-12-05 — No Unit Tests for AgentAuditLog
 *
 * Tests for FileAgentAuditLog and NullAuditLog.
 *
 * We use real temporary directories (no mocking) to exercise the actual
 * file I/O, which is the recommended approach from the story plan.
 * Tests run in the Vitest/Node suite; no Electron runtime required.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileAgentAuditLog, NullAuditLog } from './audit-log';
import type { AuditEntry } from './audit-log';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    ts: Date.now(),
    agentId: 'claude',
    project: '/workspace/test-project',
    tool: 'Edit',
    ...overrides,
  };
}

// ── NullAuditLog ──────────────────────────────────────────────────────────

describe('NullAuditLog', () => {
  it('append() is a no-op and does not throw', () => {
    const log = new NullAuditLog();
    expect(() => log.append(makeEntry())).not.toThrow();
  });

  it('readLast() returns an empty array', () => {
    const log = new NullAuditLog();
    expect(log.readLast(10)).toEqual([]);
  });

  it('readLast() with n=0 returns an empty array', () => {
    const log = new NullAuditLog();
    expect(log.readLast(0)).toEqual([]);
  });
});

// ── FileAgentAuditLog ─────────────────────────────────────────────────────

describe('FileAgentAuditLog', () => {
  let tmpDir: string;
  let auditPath: string;
  let log: FileAgentAuditLog;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-audit-test-'));
    auditPath = path.join(tmpDir, 'audit.log');
    log = new FileAgentAuditLog(auditPath);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // T1 — append writes a valid JSONL line
  it('appends a valid JSONL line to the audit file', () => {
    const entry = makeEntry({ agentId: 'claude', tool: 'Edit' });
    log.append(entry);

    const raw = fs.readFileSync(auditPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0] ?? '') as AuditEntry;
    expect(parsed.agentId).toBe('claude');
    expect(parsed.tool).toBe('Edit');
    expect(parsed.project).toBe('/workspace/test-project');
    expect(typeof parsed.ts).toBe('number');
  });

  it('appends multiple entries, each on its own line', () => {
    log.append(makeEntry({ tool: 'Edit' }));
    log.append(makeEntry({ tool: 'Write' }));
    log.append(makeEntry({ tool: 'Bash' }));

    const raw = fs.readFileSync(auditPath, 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    expect(lines).toHaveLength(3);

    const tools = lines.map((l) => (JSON.parse(l) as AuditEntry).tool);
    expect(tools).toEqual(['Edit', 'Write', 'Bash']);
  });

  // T2 — readLast returns at most n entries in order
  it('readLast returns the last n entries in chronological order', () => {
    for (let i = 0; i < 15; i++) {
      log.append(makeEntry({ ts: i, tool: `Tool-${i}` }));
    }
    const entries = log.readLast(10);
    expect(entries).toHaveLength(10);
    // Oldest of the returned window is Tool-5 (index 5 → ts 5)
    expect(entries[0]?.ts).toBe(5);
    // Newest is Tool-14 (ts 14)
    expect(entries[9]?.ts).toBe(14);
  });

  it('readLast returns all entries when n >= total count', () => {
    for (let i = 0; i < 5; i++) {
      log.append(makeEntry({ ts: i }));
    }
    const entries = log.readLast(100);
    expect(entries).toHaveLength(5);
  });

  it('readLast returns empty array when file does not exist', () => {
    const noFile = new FileAgentAuditLog(path.join(tmpDir, 'nonexistent.log'));
    expect(noFile.readLast(10)).toEqual([]);
  });

  it('readLast skips malformed JSONL lines without crashing', () => {
    fs.writeFileSync(auditPath, 'not-json\n' + JSON.stringify(makeEntry({ tool: 'Read' })) + '\n');
    const entries = log.readLast(10);
    // Only the valid line should be returned
    expect(entries).toHaveLength(1);
    expect(entries[0]?.tool).toBe('Read');
  });

  // T3 — rotation: appending past 1 MB produces a timestamped backup
  it('rotates the file when it exceeds 1 MiB — backup has timestamp in filename', () => {
    const bigEntry: AuditEntry = { ts: 1, agentId: 'a'.repeat(100), project: 'p'.repeat(100), tool: 'Edit' };
    while (!fs.existsSync(auditPath) || fs.statSync(auditPath).size < 1_048_576) {
      log.append(bigEntry);
    }

    log.append(makeEntry({ ts: 2, tool: 'Write' }));

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit.log.') && f.endsWith('.jsonl'));
    expect(backups.length).toBeGreaterThanOrEqual(1);
    // New file starts fresh.
    expect(fs.statSync(auditPath).size).toBeLessThan(1_048_576);
    // UC-FIX-014: no longer the old `.1` scheme.
    expect(fs.existsSync(auditPath + '.1')).toBe(false);
  });

  // UC-FIX-014 AC1: two consecutive rotations produce two distinct backups.
  it('AC1: two consecutive rotations both preserve their backup files', () => {
    const bigEntry: AuditEntry = { ts: 1, agentId: 'a'.repeat(100), project: 'p'.repeat(100), tool: 'Edit' };
    // First rotation.
    while (!fs.existsSync(auditPath) || fs.statSync(auditPath).size < 1_048_576) {
      log.append(bigEntry);
    }
    log.append(makeEntry({ ts: 2 }));
    // Second rotation.
    while (fs.statSync(auditPath).size < 1_048_576) {
      log.append(bigEntry);
    }
    log.append(makeEntry({ ts: 3 }));

    const backups = fs.readdirSync(tmpDir).filter((f) => f.startsWith('audit.log.') && f.endsWith('.jsonl'));
    expect(backups.length).toBeGreaterThanOrEqual(2);
  });

  // UC-FIX-014 AC2: sweep removes files older than the retention window.
  it('AC2: sweepOldBackups removes files older than the retention window', () => {
    // Write a stale backup manually (mtime set far in the past via workaround).
    const staleFile = `${auditPath}.20200101T000000Z.jsonl`;
    fs.writeFileSync(staleFile, 'old-data\n');
    // Set mtime to 31 days ago.
    const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, old, old);

    // Write a fresh backup.
    const freshFile = `${auditPath}.20991231T235959Z.jsonl`;
    fs.writeFileSync(freshFile, 'fresh-data\n');

    // Trigger a rotation to invoke sweepOldBackups.
    const bigEntry: AuditEntry = { ts: 1, agentId: 'a'.repeat(100), project: 'p'.repeat(100), tool: 'Edit' };
    while (!fs.existsSync(auditPath) || fs.statSync(auditPath).size < 1_048_576) {
      log.append(bigEntry);
    }
    log.append(makeEntry());

    expect(fs.existsSync(staleFile)).toBe(false);
    expect(fs.existsSync(freshFile)).toBe(true);
  });

  // T4 — append does not throw when file path is unwritable
  it('does not throw when appending to an unwritable path', () => {
    const badLog = new FileAgentAuditLog('/nonexistent/directory/audit.log');
    expect(() => badLog.append(makeEntry())).not.toThrow();
  });

  it('does not throw when appending to a path whose parent directory is missing', () => {
    // Use a deeply nested path that cannot exist
    const deepLog = new FileAgentAuditLog(
      path.join(tmpDir, 'deep', 'nested', 'missing', 'audit.log'),
    );
    // Should silently swallow the ENOENT/ENOTDIR error
    expect(() => deepLog.append(makeEntry())).not.toThrow();
  });
});
