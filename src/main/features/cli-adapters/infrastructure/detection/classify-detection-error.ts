/**
 * UC-FIX-006: sanitise detection error messages before forwarding to the
 * renderer. Raw Node.js error messages (e.g. "spawn ENOENT C:\Users\…")
 * can contain absolute paths and env-var values that constitute host PII.
 *
 * This helper classifies the error by errno code and returns a safe label
 * for the renderer and the raw detail for main-process logs only.
 */

export interface ClassifiedDetectionError {
  /** Safe, path-free label forwarded to the renderer as `unavailableReason`. */
  label: string;
  /** Raw error detail — log server-side, never send to the renderer. */
  rawForLog: string;
}

function toRaw(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as NodeJS.ErrnoException).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function classifyDetectionError(err: unknown): ClassifiedDetectionError {
  const rawForLog = toRaw(err);
  const code = errnoCode(err);

  if (code === 'ENOENT') return { label: 'Binary not found on PATH.', rawForLog };
  if (code === 'EACCES') return { label: 'Binary is not executable.', rawForLog };
  if (code === 'ETIMEDOUT' || code === 'ESPAWN' || rawForLog.toLowerCase().includes('timed out')) {
    return { label: 'Detection probe timed out.', rawForLog };
  }
  return { label: 'Detection failed.', rawForLog };
}
