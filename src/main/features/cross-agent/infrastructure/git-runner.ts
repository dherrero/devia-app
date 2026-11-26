import { execFileSync } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Runs `git` in a directory. Synchronous and never throws: failures come back as `ok: false`. */
export interface GitRunner {
  run(cwd: string, args: readonly string[]): GitResult;
}

const GIT_TIMEOUT_MS = 30_000;

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

export function createGitRunner(): GitRunner {
  return {
    run(cwd, args) {
      try {
        const stdout = execFileSync('git', [...args], {
          cwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: GIT_TIMEOUT_MS,
        });
        return { ok: true, stdout: stdout.trim(), stderr: '' };
      } catch (err) {
        const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
        return { ok: false, stdout: text(e.stdout).trim(), stderr: (text(e.stderr) || e.message || '').trim() };
      }
    },
  };
}
