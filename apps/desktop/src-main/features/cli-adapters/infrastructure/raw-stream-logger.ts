import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Captures the raw stdout + stderr of each CLI agent child process as JSONL,
 * one file per run. Purpose: validate parser/adapter mappers against actual
 * binary output without modifying code in-flight, and provide ground truth
 * when bringing a new CLI on board.
 *
 * Active only when running under `npm run dev:desktop` (`NODE_ENV=development`
 * or an unpackaged Electron) OR when `DEVIA_LOG_RAW_CLI=1` is set (the
 * support-mode escape hatch for packaged builds).
 *
 * The logger is a write-only side-effect parallel to the parser: every chunk
 * is also handed to the stream parser without delay; this never blocks the
 * IPC path. Capped at 10 MiB per file — past that, a final marker line is
 * written and further chunks dropped silently (rotation across files would
 * fragment a single run's evidence, which is the opposite of what we want).
 *
 * Files live under `~/.devia-app/logs/agent-cli/<agentId>/<isoTs>-<runIdShort>.jsonl`.
 * `purgeOldRawLogs()` should be called once at app start to evict files older
 * than 7 days.
 */

/** Hard cap per file. Beyond this we stop appending and write a final marker. */
const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Retention window for purge. */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export interface RawStreamLogger {
  /** Append a chunk emitted by the child process to the log. No-op when disabled. */
  write(stream: 'stdout' | 'stderr', chunk: string): void;
  /** Flush any pending I/O and close the file handle. Safe to call twice. */
  close(): void;
}

/** Resolves the root directory used by the raw logger. Exported for tests. */
export function rawLogsRoot(homeOverride?: string): string {
  return path.join(homeOverride ?? os.homedir(), '.devia-app', 'logs', 'agent-cli');
}

/**
 * Returns true when the raw logger should be active.
 *
 * `isDev` carries the launcher's existing IS_DEV decision (NODE_ENV=development
 * or unpackaged Electron). The env-var escape hatch lets users on a packaged
 * build flip logging on for one session without rebuilding.
 */
export function shouldEnableRawLogger(
  isDev: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (isDev) return true;
  const v = env['DEVIA_LOG_RAW_CLI'];
  return v === '1' || v === 'true' || v === 'yes';
}

/**
 * Build a logger for one run. When `enabled === false` returns a no-op,
 * which keeps the launcher's call sites uniform and zero-cost in prod.
 *
 * `now` is injectable so tests can produce deterministic filenames.
 */
export function createRawStreamLogger(opts: {
  enabled: boolean;
  agentId: string;
  runId: string;
  rootDir?: string;
  now?: () => Date;
}): RawStreamLogger {
  if (!opts.enabled) return NO_OP_LOGGER;

  const root = opts.rootDir ?? rawLogsRoot();
  const dir = path.join(root, sanitizeSegment(opts.agentId));
  let fd: number;
  let bytesWritten = 0;
  let exhausted = false;
  let closed = false;

  try {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = (opts.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    const shortRun = opts.runId.slice(0, 8) || 'run';
    const file = path.join(dir, `${stamp}-${shortRun}.jsonl`);
    fd = fs.openSync(file, 'a');
  } catch (err) {
    console.warn('[raw-stream-logger] disabled — could not open log file:', err);
    return NO_OP_LOGGER;
  }

  const writeLine = (line: string): void => {
    if (exhausted || closed) return;
    const buf = Buffer.from(line, 'utf8');
    if (bytesWritten + buf.length > MAX_FILE_BYTES) {
      exhausted = true;
      try {
        fs.writeSync(fd, `{"ts":${Date.now()},"stream":"meta","note":"truncated at ${MAX_FILE_BYTES} bytes"}\n`);
      } catch { /* swallow — exhausted is set so we stop writing */ }
      return;
    }
    try {
      fs.writeSync(fd, buf);
      bytesWritten += buf.length;
    } catch (err) {
      exhausted = true;
      console.warn('[raw-stream-logger] write failed, disabling for this run:', err);
    }
  };

  return {
    write(stream, chunk): void {
      // JSON.stringify takes care of escaping newlines / quotes / control bytes
      // so each line of the file is still a valid standalone JSON object.
      writeLine(
        `{"ts":${Date.now()},"stream":${JSON.stringify(stream)},"chunk":${JSON.stringify(chunk)}}\n`,
      );
    },
    close(): void {
      if (closed) return;
      closed = true;
      try { fs.closeSync(fd); } catch { /* already closed by GC / OS */ }
    },
  };
}

const NO_OP_LOGGER: RawStreamLogger = {
  write: () => undefined,
  close: () => undefined,
};

/**
 * Best-effort deletion of raw logs older than 7 days. Called at app boot so
 * the directory does not grow without bound across the months a developer
 * leaves dev-mode toggled on. Errors are swallowed: this is housekeeping,
 * not load-bearing.
 *
 * `now` and `rootDir` are injectable for tests.
 */
export function purgeOldRawLogs(opts: {
  rootDir?: string;
  now?: () => Date;
} = {}): void {
  const root = opts.rootDir ?? rawLogsRoot();
  if (!fs.existsSync(root)) return;
  const cutoff = (opts.now?.() ?? new Date()).getTime() - MAX_AGE_MS;
  let entries: string[];
  try { entries = fs.readdirSync(root); } catch { return; }
  for (const agentDir of entries) {
    const agentPath = path.join(root, agentDir);
    let stat: fs.Stats;
    try { stat = fs.statSync(agentPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    let files: string[];
    try { files = fs.readdirSync(agentPath); } catch { continue; }
    for (const file of files) {
      const filePath = path.join(agentPath, file);
      try {
        const s = fs.statSync(filePath);
        if (s.mtimeMs < cutoff) fs.unlinkSync(filePath);
      } catch { /* swallow */ }
    }
  }
}

/** Sanitises a path segment to avoid traversal via a hostile agentId. */
function sanitizeSegment(s: string): string {
  const cleaned = s.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  // After stripping path separators and dots, the only remaining traversal
  // primitives are an empty string or a single '_' run — neither of which
  // escapes the parent directory. Fall back to 'unknown' for the empty case.
  return cleaned || 'unknown';
}
