import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkOutboundFile, formatBytes } from './outbound-file-guard';

let tmp = '';
let ws = '';

function write(rel: string, content = 'x', base = ws): string {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function sparse(rel: string, bytes: number): string {
  const file = path.join(ws, rel);
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
  return file;
}

function check(requestedPath: string, roots: readonly string[] = [ws], cwd = ws) {
  return checkOutboundFile({ requestedPath, cwd, roots });
}

beforeEach(() => {
  // os.tmpdir() on macOS is a symlink (/var → /private/var): the guard must
  // cope with roots given in their unresolved form.
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-guard-'));
  ws = path.join(tmp, 'ws');
  fs.mkdirSync(ws);
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('checkOutboundFile', () => {
  it('accepts a relative path and reports the real path, size and mime', () => {
    write('out/shot.png', 'png!');
    const result = check('out/shot.png');
    const stat = fs.lstatSync(path.join(ws, 'out/shot.png'));
    expect(result).toEqual({
      ok: true,
      absPath: fs.realpathSync.native(path.join(ws, 'out/shot.png')),
      name: 'shot.png',
      size: 4,
      mime: 'image/png',
      kind: 'photo',
      dev: stat.dev,
      ino: stat.ino,
    });
  });

  it('accepts an absolute path inside a root', () => {
    const file = write('report.pdf');
    const result = check(file);
    expect(result.ok && result.kind).toBe('document');
  });

  it('resolves relative paths against cwd, not the process cwd', () => {
    write('sub/a.txt');
    expect(check('a.txt', [ws], path.join(ws, 'sub')).ok).toBe(true);
  });

  it('refuses ../ escaping the root without touching the target', () => {
    write('outside.txt', 'x', tmp);
    const result = check('../outside.txt');
    expect(result).toMatchObject({ ok: false, reason: 'outside_roots' });
    expect(!result.ok && result.message).toContain('outside the allowed folders');
  });

  it('refuses a sibling folder that merely shares the prefix', () => {
    write('f.txt', 'x', path.join(tmp, 'ws-evil'));
    expect(check(path.join(tmp, 'ws-evil', 'f.txt'))).toMatchObject({ reason: 'outside_roots' });
  });

  it('refuses a symlink inside the root that points outside', () => {
    const target = write('secret-ish.txt', 'x', tmp);
    fs.symlinkSync(target, path.join(ws, 'link.txt'));
    expect(check('link.txt')).toMatchObject({ ok: false, reason: 'outside_roots' });
  });

  it('accepts a symlink that stays inside the root', () => {
    write('real.txt');
    fs.symlinkSync(path.join(ws, 'real.txt'), path.join(ws, 'alias.txt'));
    const result = check('alias.txt');
    expect(result.ok && result.name).toBe('real.txt');
  });

  it('refuses a symlink whose real target is a secret', () => {
    write('.env', 'TOKEN=1');
    fs.symlinkSync(path.join(ws, '.env'), path.join(ws, 'harmless.txt'));
    expect(check('harmless.txt')).toMatchObject({ ok: false, reason: 'secret' });
  });

  it('refuses a directory', () => {
    fs.mkdirSync(path.join(ws, 'dir'));
    const result = check('dir');
    expect(result).toMatchObject({ ok: false, reason: 'not_a_file' });
    expect(!result.ok && result.message).toContain('zip');
  });

  it('refuses a missing file', () => {
    expect(check('nope.txt')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it.each([
    '.env',
    'config/.env.local',
    '.envrc',
    '.env-prod',
    '.env_local',
    '.env.example',
    '.git-credentials',
    '.zsh_history',
    'infra/prod.tfvars',
    '.ssh/id_rsa',
    'certs/server.pem',
    '.git/config',
  ])(
    'refuses the secret %s',
    (rel) => {
      write(rel, 'SECRET');
      const result = check(rel);
      expect(result).toMatchObject({ ok: false, reason: 'secret' });
      expect(!result.ok && result.message).not.toContain('SECRET');
    },
  );

  it('does not refuse everything because the WORKSPACE folder name looks secret', () => {
    const root = path.join(tmp, 'credentials-api');
    write('README.md', 'x', root);
    expect(check('README.md', [root], root).ok).toBe(true);
  });

  it('refuses a file over the cap with a human size and a suggestion', () => {
    sparse('big.zip', 60 * 1024 * 1024);
    const result = check('big.zip');
    expect(result).toMatchObject({ ok: false, reason: 'too_large' });
    expect(!result.ok && result.message).toContain('60 MB');
    expect(!result.ok && result.message).toContain('50 MB');
    expect(!result.ok && result.message).toMatch(/compress|split/i);
  });

  it('honours a custom maxBytes', () => {
    write('a.txt', '12345');
    expect(checkOutboundFile({ requestedPath: 'a.txt', cwd: ws, roots: [ws], maxBytes: 4 }))
      .toMatchObject({ reason: 'too_large' });
  });

  it.each([
    ['', ws],
    ['a\0b', ws],
    ['rel.txt', 'not-absolute'],
  ])('refuses invalid input %j (cwd %s)', (p, cwd) => {
    expect(check(p, [ws], cwd)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  it('refuses a file with more than one hard link, even under a harmless name', () => {
    const original = write('notes.txt', 'SECRET');
    fs.linkSync(original, path.join(ws, 'copy.txt'));
    const result = check('copy.txt');
    expect(result).toMatchObject({ ok: false, reason: 'hardlink' });
    expect(!result.ok && result.message).toContain('multiple hard links');
    expect(check('notes.txt')).toMatchObject({ ok: false, reason: 'hardlink' });
  });

  it('refuses a hard link to a file outside the workspace', () => {
    const outsideFile = write('id_rsa', 'KEY', tmp);
    fs.linkSync(outsideFile, path.join(ws, 'innocent.txt'));
    expect(check('innocent.txt')).toMatchObject({ ok: false, reason: 'hardlink' });
  });

  it('works with a root given as a symlink to the workspace', () => {
    const alias = path.join(tmp, 'ws-alias');
    fs.symlinkSync(ws, alias);
    write('out/a.txt');
    const result = checkOutboundFile({ requestedPath: 'out/a.txt', cwd: alias, roots: [alias] });
    expect(result.ok && result.absPath).toBe(fs.realpathSync.native(path.join(ws, 'out/a.txt')));
  });

  it('judges files behind a symlinked root on their real path (a secret stays refused)', () => {
    const alias = path.join(tmp, 'ws-alias');
    fs.symlinkSync(ws, alias);
    write('.envrc', 'export TOKEN=1');
    expect(checkOutboundFile({ requestedPath: '.envrc', cwd: alias, roots: [alias] })).toMatchObject({
      ok: false,
      reason: 'secret',
    });
  });

  describe("Devia's data dir", () => {
    let deviaDir = '';
    beforeEach(() => {
      deviaDir = path.join(ws, '.devia-app');
      write('memory/store.json', '{}', deviaDir);
      write('agent-logs/run.jsonl', '{}', deviaDir);
      write('outbox-archive/1_report.pdf', 'pdf', deviaDir);
    });

    it.each(['memory/store.json', 'agent-logs/run.jsonl', 'outbox-archive/1_report.pdf'])(
      'refuses %s even though the workspace root contains it',
      (rel) => {
        const result = checkOutboundFile({
          requestedPath: path.join(deviaDir, rel),
          cwd: ws,
          roots: [ws],
          denyRoots: [deviaDir],
        });
        expect(result).toMatchObject({ ok: false, reason: 'devia_data' });
        expect(!result.ok && result.message).toContain("Devia's private data folder");
      },
    );

    it('refuses a symlink in the workspace that points into it', () => {
      fs.symlinkSync(path.join(deviaDir, 'memory/store.json'), path.join(ws, 'mem.json'));
      expect(checkOutboundFile({ requestedPath: 'mem.json', cwd: ws, roots: [ws], denyRoots: [deviaDir] }))
        .toMatchObject({ ok: false, reason: 'devia_data' });
    });

    it('still allows a live session worktree nested inside it (most specific wins)', () => {
      const worktree = path.join(deviaDir, 'worktrees', 'p', 's1');
      write('out/a.txt', 'x', worktree);
      const result = checkOutboundFile({
        requestedPath: 'out/a.txt',
        cwd: worktree,
        roots: [ws, worktree],
        denyRoots: [deviaDir],
      });
      expect(result.ok).toBe(true);
      // …but not its siblings.
      expect(
        checkOutboundFile({
          requestedPath: path.join(deviaDir, 'memory/store.json'),
          cwd: worktree,
          roots: [ws, worktree],
          denyRoots: [deviaDir],
        }),
      ).toMatchObject({ ok: false, reason: 'devia_data' });
    });

    it('allows the rest of the workspace', () => {
      write('report.pdf');
      expect(checkOutboundFile({ requestedPath: 'report.pdf', cwd: ws, roots: [ws], denyRoots: [deviaDir] }).ok)
        .toBe(true);
    });
  });

  describe('a root that is the home folder or above it', () => {
    it.each([
      ['equal to home', (): string => ws],
      ['an ancestor of home', (): string => tmp],
    ])('disables sending when the only root is %s', (_label, root) => {
      write('report.pdf');
      const result = checkOutboundFile({
        requestedPath: path.join(ws, 'report.pdf'),
        cwd: ws,
        roots: [root()],
        homeDir: ws,
      });
      expect(result).toMatchObject({ ok: false, reason: 'home_root' });
      expect(!result.ok && result.message).toContain('home folder');
    });

    it('keeps a narrower root usable next to a too-broad one', () => {
      const worktree = path.join(ws, 'wt');
      write('a.txt', 'x', worktree);
      write('b.txt');
      const input = { cwd: worktree, roots: [ws, worktree], homeDir: ws };
      expect(checkOutboundFile({ ...input, requestedPath: 'a.txt' }).ok).toBe(true);
      expect(checkOutboundFile({ ...input, requestedPath: path.join(ws, 'b.txt') })).toMatchObject({
        ok: false,
        reason: 'outside_roots',
      });
    });

    it('accepts a root below home', () => {
      write('a.txt');
      expect(checkOutboundFile({ requestedPath: 'a.txt', cwd: ws, roots: [ws], homeDir: tmp }).ok).toBe(true);
      expect(
        checkOutboundFile({ requestedPath: 'a.txt', cwd: ws, roots: [ws], homeDir: path.join(tmp, 'elsewhere') })
          .ok,
      ).toBe(true);
    });
  });

  it('refuses everything when no root is configured', () => {
    write('a.txt');
    expect(check('a.txt', [])).toMatchObject({ ok: false, reason: 'outside_roots' });
  });
});

describe('formatBytes', () => {
  it.each([
    [12, '12 B'],
    [1536, '1.5 KB'],
    [60 * 1024 * 1024, '60 MB'],
    [50 * 1024 * 1024, '50 MB'],
  ])('%i → %s', (n, out) => {
    expect(formatBytes(n)).toBe(out);
  });
});
