/**
 * Cursor-agent auth-status probe (REV-AGENT-CORE-008 / REV-AGENT-CORE-010).
 *
 * Runs `cursor-agent status` and classifies stdout. Raw output is never
 * logged or surfaced — may contain partial tokens.
 *
 * Classification (case-insensitive substring on combined stdout+stderr):
 *   "logged in" | "authenticated"             → ok
 *   "not logged in" | "login required"
 *     | "please log in" | "not authenticated"  → missing
 *   anything else / ENOENT / timeout           → unknown
 */
import { execFile } from 'node:child_process';
import type { AuthProbeResult } from '../../domain/runtime-agent-def';

const AUTH_PROBE_TIMEOUT_MS = 5_000;

export function probeCursorAgentAuthStatus(
  resolvedBin: string,
  env: NodeJS.ProcessEnv,
): Promise<AuthProbeResult> {
  return new Promise<AuthProbeResult>((resolve) => {
    let settled = false;
    const safeResolve = (r: AuthProbeResult) => { if (!settled) { settled = true; resolve(r); } };
    let child: ReturnType<typeof execFile> | null = null;
    const timer = setTimeout(() => {
      child?.kill();
      safeResolve({ status: 'unknown', message: 'Auth probe timed out.' });
    }, AUTH_PROBE_TIMEOUT_MS);

    try {
      child = execFile(
        resolvedBin,
        ['status'],
        { env, encoding: 'utf8', maxBuffer: 256 * 1024, timeout: AUTH_PROBE_TIMEOUT_MS },
        (err, stdout, stderr) => {
          clearTimeout(timer);
          if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
            safeResolve({ status: 'unknown' });
            return;
          }
          const combined = `${stdout ?? ''}\n${stderr ?? ''}`.toLowerCase();
          if (
            combined.includes('not logged in') ||
            combined.includes('login required') ||
            combined.includes('please log in') ||
            combined.includes('not authenticated')
          ) {
            safeResolve({
              status: 'missing',
              message: 'Cursor-agent is not logged in. Run `cursor-agent login` in your terminal.',
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
