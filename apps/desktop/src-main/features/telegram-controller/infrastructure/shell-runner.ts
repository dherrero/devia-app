/**
 * Gated shell passthrough for the Telegram controller (E-DSK-14 #330).
 *
 * Runs a command in the active project's directory and returns the captured
 * output. The router only calls this when `config.remoteControl.allowShell` is
 * on (off by default), so this module assumes authorisation has already been
 * granted; it still bounds the blast radius with a timeout and an output cap.
 */
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import type { ConfigRepository } from '../../../shared/ports';

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
}

export interface ShellRunner {
  run(project: string, command: string): Promise<ShellResult>;
}

/** Keep the last N chars of combined stdout/stderr (Telegram-friendly). */
const MAX_OUTPUT_CHARS = 8000;
const TIMEOUT_MS = 5 * 60 * 1000;
const REMOTE_SHELL_ENV_KEYS = [
  'PATH',
  'Path',
  'PATHEXT',
  'HOME',
  'USERPROFILE',
  'SystemRoot',
  'WINDIR',
  'COMSPEC',
  'ComSpec',
  'SHELL',
  'TMP',
  'TEMP',
  'TMPDIR',
  'LANG',
  'LC_ALL',
] as const;

export function buildRemoteShellEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of REMOTE_SHELL_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function createShellRunner(config: ConfigRepository): ShellRunner {
  return {
    run(project: string, command: string): Promise<ShellResult> {
      const cwd = path.join(config.get().workspaceRoot, project);
      return new Promise<ShellResult>((resolve) => {
        let output = '';
        let timedOut = false;
        const append = (buf: Buffer): void => {
          output += buf.toString();
          if (output.length > MAX_OUTPUT_CHARS * 2) output = output.slice(-MAX_OUTPUT_CHARS * 2);
        };
        const child = spawn(command, { cwd, shell: true, env: buildRemoteShellEnv(process.env) });
        child.stdout?.on('data', append);
        child.stderr?.on('data', append);
        const timer = setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
        }, TIMEOUT_MS);
        timer.unref?.();
        child.on('close', (code) => {
          clearTimeout(timer);
          resolve({ code, output, timedOut });
        });
        child.on('error', (err) => {
          clearTimeout(timer);
          resolve({ code: 1, output: `${output}\n${String(err)}`, timedOut });
        });
      });
    },
  };
}
