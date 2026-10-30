import {
  execFile,
  execFileSync,
  spawn,
  type ChildProcess,
  type ExecFileOptions,
  type ExecFileSyncOptions,
  type ExecFileSyncOptionsWithStringEncoding,
  type SpawnOptions,
} from 'node:child_process';

import { resolveOnPath } from './detection/path-resolver';
import { createCommandInvocation } from './spawn-invocation';

type ExecFileSyncResult = string | Buffer;

export interface ExecFileOnPathResult {
  stdout: string;
  stderr: string;
}

export function spawnOnPath(
  command: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  const resolvedCommand = resolveOnPath(command) ?? command;
  const invocation = createCommandInvocation({
    command: resolvedCommand,
    args,
    env: options.env ?? process.env,
  });

  return spawn(invocation.command, invocation.args, {
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  });
}

export function execFileOnPath(
  command: string,
  args: readonly string[],
  options: ExecFileOptions = {},
): Promise<ExecFileOnPathResult> {
  const resolvedCommand = resolveOnPath(command) ?? command;
  const invocation = createCommandInvocation({
    command: resolvedCommand,
    args,
    env: options.env ?? process.env,
  });

  return new Promise((resolve, reject) => {
    execFile(
      invocation.command,
      invocation.args,
      {
        ...options,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        encoding: 'utf8',
      } as ExecFileOptions,
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function execFileSyncOnPath(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptionsWithStringEncoding,
): string;
export function execFileSyncOnPath(
  command: string,
  args: readonly string[],
  options?: ExecFileSyncOptions,
): Buffer;
export function execFileSyncOnPath(
  command: string,
  args: readonly string[],
  options: ExecFileSyncOptions | ExecFileSyncOptionsWithStringEncoding = {},
): ExecFileSyncResult {
  const resolvedCommand = resolveOnPath(command) ?? command;
  const invocation = createCommandInvocation({
    command: resolvedCommand,
    args,
    env: options.env ?? process.env,
  });
  const execOptions = {
    ...options,
    windowsVerbatimArguments: invocation.windowsVerbatimArguments,
  } as unknown as ExecFileSyncOptionsWithStringEncoding;
  return execFileSync(invocation.command, invocation.args, execOptions);
}
