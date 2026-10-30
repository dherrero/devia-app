import * as os from 'node:os';
import * as path from 'node:path';

import type { EngramDetectionResult } from '../../../../shared/domain/memory';

// Re-export so existing imports of this type from this module keep working.
export type { EngramDetectionResult } from '../../../../shared/domain/memory';

// ── injectable dependency types ───────────────────────────────────────────

/**
 * Injectable exec runner for cross-platform binary resolution.
 * Using spawnSync-style return so the caller stays synchronous.
 */
export interface ExecRunner {
  /** Run a command synchronously. Returns stdout on success, null on any error. */
  run(command: string, args: string[], timeoutMs: number): string | null;
}

/** Injectable filesystem existence check. */
export interface FsExistsFn {
  (filePath: string): boolean;
}

// ── default implementations (production) ─────────────────────────────────

/** Production exec runner using spawnSync. */
export function makeSpawnSyncRunner(): ExecRunner {
  // Imported inside the function so the module stays importable in test
  // environments that do not have a real child_process available.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');

  return {
    run(command: string, args: string[], timeoutMs: number): string | null {
      try {
        const result = spawnSync(command, args, {
          encoding: 'utf8',
          timeout: timeoutMs,
          // Prevent shell injection; command is always a fixed known value.
          shell: false,
        });
        if (result.error || result.status !== 0) return null;
        const stdout = result.stdout;
        return typeof stdout === 'string' ? stdout.trim() : null;
      } catch {
        return null;
      }
    },
  };
}

// ── path helpers ──────────────────────────────────────────────────────────

function engramDataDir(): string {
  return process.env['ENGRAM_DATA_DIR'] ?? path.join(os.homedir(), '.engram');
}

// ── use case ──────────────────────────────────────────────────────────────

/**
 * Detect whether engram is installed on the current machine.
 *
 * Detection is fully synchronous and side-effect free with respect to
 * Devia's own data store (no writes, no network). The two injected
 * deps (exec runner, fs exists) let tests verify behaviour without
 * touching real processes or the real filesystem.
 */
export class DetectEngramUseCase {
  private static readonly BINARY_TIMEOUT_MS = 3_000;

  constructor(
    private readonly exec: ExecRunner,
    private readonly fsExists: FsExistsFn,
  ) {}

  execute(): EngramDetectionResult {
    const dbPath = path.join(engramDataDir(), 'engram.db');
    const hasDb = this.fsExists(dbPath);

    // Platform-specific binary lookup (matches the contract in the spike doc).
    const isWin = process.platform === 'win32';
    const lookupCmd = isWin ? 'where' : 'which';
    // The injected runner is contracted to return null on error, but we stay
    // defensive: a misbehaving runner that throws must never break detection.
    let rawPath: string | null;
    try {
      rawPath = this.exec.run(lookupCmd, ['engram'], DetectEngramUseCase.BINARY_TIMEOUT_MS);
    } catch {
      rawPath = null;
    }

    // `which`/`where` may return multiple lines on Windows; take the first.
    const resolvedBin = rawPath ? rawPath.split(/\r?\n/)[0]?.trim() || undefined : undefined;
    const hasBinary = resolvedBin !== undefined && resolvedBin.length > 0;

    return {
      present: hasBinary || hasDb,
      hasBinary,
      hasDb,
      ...(hasBinary && resolvedBin !== undefined && { binPath: resolvedBin }),
      ...(hasDb && { dbPath }),
    };
  }
}
