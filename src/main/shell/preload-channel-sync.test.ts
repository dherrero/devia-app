/**
 * REV-TS-CLI-01-01 — Preload Channel String Sync Risk
 *
 * Ensures every IPC channel string defined in `shared/contracts/ipc-channels.ts`
 * is referenced in `src/main/shell/preload.ts`. If a channel is renamed in the
 * canonical registry but not updated in preload.ts, this test fails with a
 * clear message identifying the missing channel.
 *
 * This is an interim guard; the long-term fix (bundling preload with esbuild so
 * it can import ipc-channels.ts directly) is tracked in ADR-001 Section 10.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IPC } from '../../shared/contracts/ipc-channels';

// Resolve preload.ts relative to this test file's directory.
const preloadPath = path.resolve(__dirname, 'preload.ts');
const preloadSource = fs.readFileSync(preloadPath, 'utf8');

describe('preload channel sync', () => {
  it('every IPC channel registered in ipc-channels.ts appears in preload.ts', () => {
    const missing: Array<{ key: string; channel: string }> = [];

    for (const [key, channel] of Object.entries(IPC)) {
      if (!preloadSource.includes(`'${channel}'`)) {
        missing.push({ key, channel });
      }
    }

    expect(
      missing,
      `The following IPC channels are defined in ipc-channels.ts but not referenced in preload.ts:\n` +
        missing.map((m) => `  IPC.${m.key} = '${m.channel}'`).join('\n'),
    ).toHaveLength(0);
  });
});
