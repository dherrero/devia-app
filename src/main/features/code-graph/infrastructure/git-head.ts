import { execFile } from 'node:child_process';

const HEAD_TIMEOUT_MS = 5000;
const SHA = /^[0-9a-f]{40,64}$/;

/** HEAD commit of the repo at `cwd`; undefined for non-git folders, no commits or any error. */
export function gitHeadCommit(cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        'git',
        ['rev-parse', 'HEAD'],
        { cwd, timeout: HEAD_TIMEOUT_MS, windowsHide: true },
        (err, stdout) => {
          if (err) return resolve(undefined);
          const sha = stdout.trim();
          resolve(SHA.test(sha) ? sha : undefined);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}
