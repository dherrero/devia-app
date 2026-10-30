/**
 * Claude Code auth-status probe (REV-AGENT-CORE-010).
 *
 * Extracted from the centralised `auth-probe.ts` so it can live alongside
 * `claude.ts` as the adapter's own `authProbe` slot. The original central
 * dispatcher (`probeAgentAuthStatus`) now delegates to `def.authProbe` when
 * present.
 *
 * Classification rules (case-insensitive substring on combined stdout+stderr):
 *   - "logged in" | "authenticated"          → ok
 *   - "not logged in" | "login required"
 *     | "please log in" | "not authenticated" → missing
 *   - ENOENT | timeout | unexpected output    → unknown
 *
 * Raw process output is NEVER logged or surfaced — may contain partial tokens.
 */
import { execFile } from 'node:child_process';
import type { AuthProbeResult } from '../../domain/runtime-agent-def';

const AUTH_PROBE_TIMEOUT_MS = 5_000;

export function probeClaudeAuthStatus(
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<AuthProbeResult> {
  return new Promise<AuthProbeResult>((resolve) => {
    let settled = false;
    const safeResolve = (result: AuthProbeResult): void => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let child: ReturnType<typeof execFile> | null = null;
    const timer = setTimeout(() => {
      child?.kill();
      safeResolve({ status: 'unknown', message: 'Auth probe timed out.' });
    }, AUTH_PROBE_TIMEOUT_MS);

    try {
      child = execFile(
        resolvedBin,
        ['--status'],
        {
          env,
          encoding: 'utf8',
          maxBuffer: 256 * 1024,
          timeout: AUTH_PROBE_TIMEOUT_MS,
        },
        (err, stdout, stderr) => {
          clearTimeout(timer);
          const rawStdout: string = stdout ?? '';
          const rawStderr: string = stderr ?? '';

          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            safeResolve({ status: 'unknown' });
            return;
          }

          const combined = `${rawStdout}\n${rawStderr}`.toLowerCase();

          // Order matters: check "not logged in" before "logged in".
          if (
            combined.includes('not logged in') ||
            combined.includes('login required') ||
            combined.includes('please log in') ||
            combined.includes('not authenticated')
          ) {
            safeResolve({
              status: 'missing',
              message: "Claude is not logged in. Run `claude login` in your terminal.",
            });
            return;
          }

          if (combined.includes('logged in') || combined.includes('authenticated')) {
            safeResolve({ status: 'ok' });
            return;
          }

          safeResolve({ status: 'unknown' });
        },
      );
    } catch {
      clearTimeout(timer);
      safeResolve({ status: 'unknown' });
    }
  });
}
