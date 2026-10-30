import * as path from 'node:path';
import { describe, it, expect, vi } from 'vitest';

import {
  DetectEngramUseCase,
  type ExecRunner,
  type FsExistsFn,
} from './detect-engram.use-case';

// ── fakes ──────────────────────────────────────────────────────────────────

function makeRunner(result: string | null): ExecRunner {
  return { run: vi.fn().mockReturnValue(result) };
}

function makeFsExists(result: boolean): FsExistsFn {
  return vi.fn().mockReturnValue(result);
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('DetectEngramUseCase', () => {
  it('present=true, hasBinary=true, hasDb=true when both binary and db are found', () => {
    const runner = makeRunner('/usr/local/bin/engram');
    const fsExists = makeFsExists(true);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();

    expect(result.present).toBe(true);
    expect(result.hasBinary).toBe(true);
    expect(result.hasDb).toBe(true);
    expect(result.binPath).toBe('/usr/local/bin/engram');
    expect(result.dbPath).toMatch(/engram\.db$/);
  });

  it('hasBinary=false, hasDb=true, present=true when only db is present', () => {
    const runner = makeRunner(null);
    const fsExists = makeFsExists(true);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();

    expect(result.hasBinary).toBe(false);
    expect(result.hasDb).toBe(true);
    expect(result.present).toBe(true);
    expect('binPath' in result).toBe(false);
    expect(result.dbPath).toBeDefined();
  });

  it('hasBinary=true, hasDb=false, present=true when only binary is found', () => {
    const runner = makeRunner('/usr/bin/engram');
    const fsExists = makeFsExists(false);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();

    expect(result.hasBinary).toBe(true);
    expect(result.hasDb).toBe(false);
    expect(result.present).toBe(true);
    expect(result.binPath).toBe('/usr/bin/engram');
    // dbPath absent because hasDb is false.
    expect('dbPath' in result).toBe(false);
  });

  it('present=false when neither binary nor db are found', () => {
    const runner = makeRunner(null);
    const fsExists = makeFsExists(false);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();

    expect(result.present).toBe(false);
    expect(result.hasBinary).toBe(false);
    expect(result.hasDb).toBe(false);
    expect('binPath' in result).toBe(false);
    expect('dbPath' in result).toBe(false);
  });

  it('exec error (null return) results in hasBinary=false without throwing', () => {
    const runner: ExecRunner = {
      run: vi.fn().mockImplementation(() => { throw new Error('ENOENT'); }),
    };
    const fsExists = makeFsExists(false);
    const uc = new DetectEngramUseCase(runner, fsExists);

    // Must not throw even if run() throws.
    expect(() => uc.execute()).not.toThrow();
  });

  it('handles multi-line where output by taking the first line (Windows case)', () => {
    // Simulate Windows `where engram` returning multiple matches.
    const runner = makeRunner('C:\\tools\\engram.exe\r\nC:\\other\\engram.exe');
    const fsExists = makeFsExists(false);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();
    expect(result.binPath).toBe('C:\\tools\\engram.exe');
    expect(result.hasBinary).toBe(true);
  });

  it('respects ENGRAM_DATA_DIR environment variable for db path', () => {
    const customDir = '/custom/engram/data';
    vi.stubEnv('ENGRAM_DATA_DIR', customDir);

    // The use case joins via path.join, so on Windows the separators are
    // backslashes — compare against the same join instead of a POSIX literal.
    const expectedDbPath = path.join(customDir, 'engram.db');
    const runner = makeRunner(null);
    const fsExists: FsExistsFn = vi.fn((p: string) => p === expectedDbPath);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();

    expect(result.hasDb).toBe(true);
    expect(result.dbPath).toBe(expectedDbPath);

    vi.unstubAllEnvs();
  });

  it('dbPath is absent when hasDb=false, even with custom ENGRAM_DATA_DIR', () => {
    vi.stubEnv('ENGRAM_DATA_DIR', '/custom/dir');

    const runner = makeRunner(null);
    const fsExists = makeFsExists(false);
    const uc = new DetectEngramUseCase(runner, fsExists);

    const result = uc.execute();
    expect('dbPath' in result).toBe(false);

    vi.unstubAllEnvs();
  });
});
