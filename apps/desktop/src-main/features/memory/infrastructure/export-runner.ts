import { execFile } from 'node:child_process';

import type { ExportRunner } from '../application/import-engram.use-case';

/**
 * Production `ExportRunner`: runs `engram export <file>` as a child process.
 *
 * Resolves on a clean exit; rejects with a message that includes the word
 * "timeout" when the process is killed by the timeout (so the use case can map
 * it to the `engram-export-timeout` reason) and with stderr otherwise. The
 * command is a fixed binary with non-shell args — no shell interpolation.
 */
export function makeEngramExportRunner(): ExportRunner {
  return {
    run(binPath: string, args: string[], timeoutMs: number): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        execFile(
          binPath,
          args,
          { timeout: timeoutMs, windowsHide: true, shell: false },
          (error, _stdout, stderr) => {
            if (error) {
              // execFile sets error.killed + error.signal on timeout.
              const killed = (error as NodeJS.ErrnoException & { killed?: boolean }).killed;
              if (killed) {
                reject(new Error('engram export timed out'));
                return;
              }
              reject(new Error(stderr?.toString().trim() || error.message));
              return;
            }
            resolve();
          },
        );
      });
    },
  };
}
