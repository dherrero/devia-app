import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSpecFooter, scanCommitLinks, specFooter } from './commit-footer';

describe('commit footer (T10)', () => {
  it('specFooter builds the canonical trailer', () => {
    expect(specFooter('S-1', 'T-3')).toBe('Spec: S-1-T-3');
  });

  it('parseSpecFooter reads a trailer anywhere in the message', () => {
    expect(parseSpecFooter('feat: thing\n\nbody\n\nSpec: S-2-T-7')).toEqual({
      specId: 'S-2',
      taskId: 'T-7',
    });
  });

  it('parseSpecFooter returns null when absent or malformed', () => {
    expect(parseSpecFooter('no footer here')).toBeNull();
    expect(parseSpecFooter('Spec: nonsense')).toBeNull();
  });

  describe('scanCommitLinks', () => {
    let dir: string;
    const git = (args: string[]): void => {
      execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    };

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-git-'));
      git(['init']);
      git(['config', 'user.email', 'test@devia.dev']);
      git(['config', 'user.name', 'Test']);
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('groups commit shas by the task id in their footer', () => {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
      git(['add', '.']);
      git(['commit', '-m', 'feat: a\n\nSpec: S-1-T-1']);

      fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
      git(['add', '.']);
      git(['commit', '-m', 'feat: b\n\nSpec: S-1-T-2']);

      const links = scanCommitLinks(dir);
      expect([...links.keys()].sort()).toEqual(['T-1', 'T-2']);
      expect(links.get('T-1')).toHaveLength(1);
    });

    it('returns an empty map outside a git repo', () => {
      const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-nogit-'));
      expect(scanCommitLinks(empty).size).toBe(0);
      fs.rmSync(empty, { recursive: true, force: true });
    });
  });
});
