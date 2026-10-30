import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOutboxFlusher } from './index';
import type { ConfigRepository } from '../../shared/ports';
import type { DeviaConfig } from '../../../shared/domain/config';

function configFor(workspaceRoot: string, deviaDir: string): ConfigRepository {
  const cfg = { workspaceRoot } as DeviaConfig;
  return {
    get: () => cfg,
    set: () => cfg,
    reload: () => cfg,
    hasWorkspace: () => true,
    configPath: () => path.join(deviaDir, 'config.json'),
    deviaDir: () => deviaDir,
  };
}

describe('FsOutboxFlusher', () => {
  let tmp: string;
  let deviaDir: string;
  let project: string;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-outbox-'));
    deviaDir = path.join(tmp, '.devia-app');
    project = path.join(tmp, 'ws', 'proj-a');
    fs.mkdirSync(path.join(project, 'outbox'), { recursive: true });
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const flusher = () => createOutboxFlusher(configFor(path.join(tmp, 'ws'), deviaDir));
  const archive = () => path.join(deviaDir, 'outbox-archive');

  it('archives every file of <projectPath>/outbox with size and mime', () => {
    fs.writeFileSync(path.join(project, 'outbox', 'report.pdf'), 'pdf!');
    fs.writeFileSync(path.join(project, 'outbox', 'shot.png'), 'png');

    const flushed = flusher().flush(project);

    expect(flushed.map((f) => f.file).sort((a, b) => a.name.localeCompare(b.name))).toEqual([
      expect.objectContaining({ project: 'proj-a', name: 'report.pdf', kind: 'file', size: 4, mime: 'application/pdf' }),
      expect.objectContaining({ project: 'proj-a', name: 'shot.png', kind: 'image', size: 3, mime: 'image/png' }),
    ]);
    for (const { file } of flushed) {
      expect(path.dirname(file.path)).toBe(archive());
      expect(fs.existsSync(file.path)).toBe(true);
    }
    expect(fs.readdirSync(path.join(project, 'outbox'))).toEqual([]);
  });

  it('flushes a worktree outside the workspace when given its absolute path', () => {
    const worktree = path.join(deviaDir, 'worktrees', 'key', 'sess-1');
    fs.mkdirSync(path.join(worktree, 'outbox'), { recursive: true });
    fs.writeFileSync(path.join(worktree, 'outbox', 'a.txt'), 'a');
    fs.writeFileSync(path.join(project, 'outbox', 'base.txt'), 'b');

    const flushed = flusher().flush(worktree);

    expect(flushed.map((f) => f.file.name)).toEqual(['a.txt']);
    expect(fs.existsSync(path.join(project, 'outbox', 'base.txt'))).toBe(true);
  });

  it('ignores a relative path (it is no longer a project name) and a missing outbox', () => {
    fs.writeFileSync(path.join(project, 'outbox', 'a.txt'), 'a');
    expect(flusher().flush('proj-a')).toEqual([]);
    expect(flusher().flush(path.join(tmp, 'nowhere'))).toEqual([]);
    expect(fs.existsSync(path.join(project, 'outbox', 'a.txt'))).toBe(true);
  });

  it('runs check on the ORIGINAL path before moving and returns its verdict', () => {
    const original = path.join(project, 'outbox', 'a.txt');
    fs.writeFileSync(original, 'a');
    const check = vi.fn((entry: { path: string }) => fs.existsSync(entry.path));

    const [flushed] = flusher().flush(project, check);

    expect(check).toHaveBeenCalledWith({ path: original, name: 'a.txt' });
    expect(flushed?.verdict).toBe(true);
    expect(fs.existsSync(original)).toBe(false);
  });

  it('archives a symlink but never offers it to check', () => {
    const target = path.join(tmp, 'secret.txt');
    fs.writeFileSync(target, 's');
    fs.symlinkSync(target, path.join(project, 'outbox', 'link.txt'));
    const check = vi.fn(() => true);

    const flushed = flusher().flush(project, check);

    expect(check).not.toHaveBeenCalled();
    expect(flushed).toHaveLength(1);
    expect(flushed[0]).not.toHaveProperty('verdict');
  });

  it('skips sub-directories', () => {
    fs.mkdirSync(path.join(project, 'outbox', 'nested'));
    expect(flusher().flush(project)).toEqual([]);
  });
});
