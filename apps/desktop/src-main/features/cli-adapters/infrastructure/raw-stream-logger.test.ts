import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createRawStreamLogger,
  purgeOldRawLogs,
  rawLogsRoot,
  shouldEnableRawLogger,
} from './raw-stream-logger';

const tmpRoot = (): string =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'raw-logger-test-'));

describe('shouldEnableRawLogger', () => {
  it('enabled when isDev is true regardless of env', () => {
    expect(shouldEnableRawLogger(true, {})).toBe(true);
    expect(shouldEnableRawLogger(true, { DEVIA_LOG_RAW_CLI: '0' })).toBe(true);
  });

  it('disabled by default when isDev is false and env is empty', () => {
    expect(shouldEnableRawLogger(false, {})).toBe(false);
  });

  it('opt-in via env when isDev is false', () => {
    expect(shouldEnableRawLogger(false, { DEVIA_LOG_RAW_CLI: '1' })).toBe(true);
    expect(shouldEnableRawLogger(false, { DEVIA_LOG_RAW_CLI: 'true' })).toBe(true);
    expect(shouldEnableRawLogger(false, { DEVIA_LOG_RAW_CLI: 'yes' })).toBe(true);
    expect(shouldEnableRawLogger(false, { DEVIA_LOG_RAW_CLI: 'no' })).toBe(false);
  });
});

describe('rawLogsRoot', () => {
  it('builds the canonical path under ~/.devia-app/logs/agent-cli', () => {
    expect(rawLogsRoot('/home/dev')).toBe(path.join('/home/dev', '.devia-app', 'logs', 'agent-cli'));
  });
});

describe('createRawStreamLogger', () => {
  let root: string;

  beforeEach(() => {
    root = tmpRoot();
  });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('returns a no-op logger when enabled === false', () => {
    const logger = createRawStreamLogger({
      enabled: false,
      agentId: 'claude',
      runId: 'abc12345',
      rootDir: root,
    });
    logger.write('stdout', 'anything');
    logger.close();
    // No file should have been created.
    expect(fs.existsSync(path.join(root, 'claude'))).toBe(false);
  });

  it('writes one valid JSON line per chunk', () => {
    const logger = createRawStreamLogger({
      enabled: true,
      agentId: 'claude',
      runId: 'abc12345',
      rootDir: root,
      now: () => new Date('2026-05-30T01:02:03.456Z'),
    });
    logger.write('stdout', '{"type":"message_start"}\n');
    logger.write('stderr', 'warn: deprecated\n');
    logger.close();

    const files = fs.readdirSync(path.join(root, 'claude'));
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^2026-05-30T01-02-03-456Z-abc12345\.jsonl$/);

    const lines = fs
      .readFileSync(path.join(root, 'claude', files[0]!), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ stream: 'stdout', chunk: '{"type":"message_start"}\n' });
    expect(lines[1]).toMatchObject({ stream: 'stderr', chunk: 'warn: deprecated\n' });
    expect(typeof lines[0].ts).toBe('number');
  });

  it('sanitises agentId to prevent path traversal', () => {
    const logger = createRawStreamLogger({
      enabled: true,
      agentId: '../../etc/passwd',
      runId: 'r1',
      rootDir: root,
    });
    logger.write('stdout', 'x');
    logger.close();

    const dirs = fs.readdirSync(root);
    expect(dirs).toHaveLength(1);
    expect(dirs[0]).not.toContain('..');
    expect(dirs[0]).not.toContain('/');
  });

  it('stops appending past 10 MiB and writes a truncated marker', () => {
    const logger = createRawStreamLogger({
      enabled: true,
      agentId: 'claude',
      runId: 'big',
      rootDir: root,
    });
    // Write a chunk that itself exceeds the cap.
    const big = 'x'.repeat(11 * 1024 * 1024);
    logger.write('stdout', big);
    logger.write('stdout', 'this-should-not-appear');
    logger.close();

    const file = path.join(root, 'claude', fs.readdirSync(path.join(root, 'claude'))[0]!);
    const content = fs.readFileSync(file, 'utf8');
    expect(content).toContain('"stream":"meta"');
    expect(content).toContain('truncated at');
    expect(content).not.toContain('this-should-not-appear');
  });

  it('survives a write failure without crashing the caller', () => {
    const logger = createRawStreamLogger({
      enabled: true,
      agentId: 'claude',
      runId: 'r1',
      rootDir: root,
    });
    logger.close();
    // After close, subsequent writes are silently dropped.
    expect(() => logger.write('stdout', 'late')).not.toThrow();
  });
});

describe('purgeOldRawLogs', () => {
  let root: string;

  beforeEach(() => { root = tmpRoot(); });

  afterEach(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* swallow */ }
  });

  it('removes files older than 7 days and keeps recent ones', () => {
    const agentDir = path.join(root, 'claude');
    fs.mkdirSync(agentDir, { recursive: true });
    const oldFile = path.join(agentDir, 'old.jsonl');
    const newFile = path.join(agentDir, 'new.jsonl');
    fs.writeFileSync(oldFile, '{}');
    fs.writeFileSync(newFile, '{}');
    const now = Date.now();
    const eightDaysAgo = (now - 8 * 24 * 60 * 60 * 1000) / 1000;
    fs.utimesSync(oldFile, eightDaysAgo, eightDaysAgo);

    purgeOldRawLogs({ rootDir: root, now: () => new Date(now) });

    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(newFile)).toBe(true);
  });

  it('does nothing when the root does not exist', () => {
    expect(() => purgeOldRawLogs({ rootDir: path.join(root, 'missing') })).not.toThrow();
  });

  it('skips non-directory entries inside the root', () => {
    fs.writeFileSync(path.join(root, 'stray-file'), 'x');
    expect(() => purgeOldRawLogs({ rootDir: root })).not.toThrow();
    // Stray files left untouched (we only descend into per-agent dirs).
    expect(fs.existsSync(path.join(root, 'stray-file'))).toBe(true);
  });
});
