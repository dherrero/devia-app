import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsConfigRepository } from './fs-config-repository';

/** Runs `body` with $HOME pointed at a throwaway dir holding `persisted` (if any). */
function withConfigOnDisk(persisted: unknown, body: (repo: FsConfigRepository) => void): void {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-cfg-'));
  const prevHome = process.env['HOME'];
  process.env['HOME'] = tmp;
  try {
    if (!os.homedir().startsWith(tmp)) return;
    const repo = new FsConfigRepository();
    if (persisted !== undefined) {
      fs.mkdirSync(repo.deviaDir(), { recursive: true });
      fs.writeFileSync(repo.configPath(), JSON.stringify(persisted));
    }
    body(repo);
  } finally {
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

describe('FsConfigRepository - crossAgent (S-56)', () => {
  it('defaults to off when there is no config file', () => {
    withConfigOnDisk(undefined, (repo) => {
      expect(repo.get().crossAgent).toEqual({
        enabled: false,
        maxConcurrent: 3,
        maxPerTurn: 8,
        defaultTimeoutSec: 1800,
      });
    });
  });

  it('loads an old config without the block with the defaults, no migration needed', () => {
    withConfigOnDisk({ agentId: 'pi' }, (repo) => {
      expect(repo.get().agentId).toBe('pi');
      expect(repo.get().crossAgent?.enabled).toBe(false);
    });
  });

  it('normalises invalid persisted values', () => {
    withConfigOnDisk({ crossAgent: { enabled: true, maxConcurrent: -3, maxPerTurn: 'x' } }, (repo) => {
      expect(repo.get().crossAgent).toEqual({
        enabled: true,
        maxConcurrent: 3,
        maxPerTurn: 8,
        defaultTimeoutSec: 1800,
      });
    });
  });

  it('deep-merges a partial set() and persists it', () => {
    withConfigOnDisk({ crossAgent: { enabled: false, maxConcurrent: 2 } }, (repo) => {
      repo.set({ crossAgent: { enabled: true } as never });
      expect(repo.get().crossAgent).toEqual({
        enabled: true,
        maxConcurrent: 2,
        maxPerTurn: 8,
        defaultTimeoutSec: 1800,
      });
      expect(repo.reload().crossAgent?.enabled).toBe(true);
      expect(repo.reload().crossAgent?.maxConcurrent).toBe(2);
    });
  });
});
