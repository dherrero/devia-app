import { execFile, type ExecFileOptions } from 'node:child_process';
import { createCommandInvocation } from '../spawn-invocation';

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

/**
 * Thin promise wrapper around `child_process.execFile`. Throws on
 * non-zero exit / spawn failure (preserving `err.code` so callers can
 * classify ENOENT, EACCES, exit 126/127, etc.). Buffer caps stay
 * generous so a `<cli> models` dump with hundreds of ids doesn't get
 * truncated.
 *
 * Goes through `createCommandInvocation` so Windows `.cmd` / `.bat`
 * shims are launched the same way the run launcher launches them —
 * via `cmd.exe /d /s /c` with `windowsVerbatimArguments`. POSIX is
 * unchanged (identity transform).
 */
export function execAgentFile(
  bin: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<ExecFileResult> {
  const env = (options.env as NodeJS.ProcessEnv | undefined) ?? process.env;
  const invocation = createCommandInvocation({ command: bin, args, env });
  const finalOptions: ExecFileOptions = {
    maxBuffer: 8 * 1024 * 1024,
    ...options,
    ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
  };
  return new Promise((resolve, reject) => {
    execFile(invocation.command, invocation.args, finalOptions, (err, stdout, stderr) => {
      const so = typeof stdout === 'string' ? stdout : (stdout?.toString?.('utf8') ?? '');
      const se = typeof stderr === 'string' ? stderr : (stderr?.toString?.('utf8') ?? '');
      if (err) {
        (err as Error & { stdout?: string; stderr?: string }).stdout = so;
        (err as Error & { stdout?: string; stderr?: string }).stderr = se;
        reject(err);
        return;
      }
      resolve({ stdout: so, stderr: se });
    });
  });
}
