/**
 * UC-FIX-003: kill the full process tree when cmd.exe wraps a `.cmd` shim.
 *
 * On Windows, `spawn` with `shell: false` and a `.cmd` shim routes through
 * `cmd.exe /d /s /c`. Sending SIGTERM to the cmd.exe PID orphans the
 * underlying agent (node, codex.exe …) which keeps running after cancel.
 *
 * Fix: use `taskkill /T /F /PID <pid>` to recursively terminate every
 * process in the tree. Fall back to the provided `fallback` callback if
 * taskkill is unavailable or errors.
 *
 * POSIX: always delegates to `fallback` unchanged.
 */

import { execFile as nodeExecFile } from 'node:child_process';

export type ExecFileFn = (
  cmd: string,
  args: string[],
  cb: (err: Error | null) => void,
) => void;

export interface KillTreeOptions {
  /** Override for testing; defaults to `child_process.execFile`. */
  execFileFn?: ExecFileFn;
  /** Override for testing; defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

/**
 * Terminates the process tree rooted at `pid`.
 *
 * @param pid           PID of the direct child (the cmd.exe wrapper or the agent itself).
 * @param usedCmdShell  True when the spawn went through `cmd.exe /d /s /c` wrapping.
 * @param fallback      Called when `taskkill` is not applicable (POSIX, no pid) or fails.
 * @param opts          Injection points for platform and execFile (used in tests).
 */
export function killProcessTree(
  pid: number | undefined,
  usedCmdShell: boolean,
  fallback: () => void,
  opts: KillTreeOptions = {},
): void {
  const platform = opts.platform ?? process.platform;
  const execFileFn: ExecFileFn = opts.execFileFn ?? ((cmd, args, cb) => {
    nodeExecFile(cmd, args, (err) => cb(err));
  });

  if (platform === 'win32' && usedCmdShell && pid != null) {
    execFileFn('taskkill', ['/T', '/F', '/PID', String(pid)], (err) => {
      if (err) {
        console.warn('[devia:launcher] taskkill failed, falling back to SIGTERM:', err.message);
        fallback();
      }
    });
    return;
  }

  fallback();
}
