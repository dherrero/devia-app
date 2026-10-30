import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  RunFileGate,
  SEND_FILE_AUDIT_TOOL,
  rebindArchivedRunFile,
  revalidateOutboundFile,
  type SendFileAuditSink,
} from './outbound-file-gate';

let tmp = '';
let ws = '';
let deviaDir = '';

function write(file: string, content = 'x'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function sparse(file: string, bytes: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
  return file;
}

function revalidate(requested: string, roots: readonly string[] = [ws], cwd = ws, extra: { absPath?: string; as?: 'auto' | 'document' | 'photo' } = {}) {
  return revalidateOutboundFile({ request: { path: requested, ...extra }, cwd, roots, source: 'tool' });
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-gate-'));
  ws = path.join(tmp, 'ws');
  deviaDir = path.join(tmp, '.devia-app');
  fs.mkdirSync(ws, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('revalidateOutboundFile — the user rule (S-32)', () => {
  it('builds the RunFile from the guard, not from the request', () => {
    write(path.join(ws, 'out', 'report.pdf'), 'pdf!');
    const result = revalidate('out/report.pdf');
    const stat = fs.lstatSync(path.join(ws, 'out', 'report.pdf'));
    expect(result).toEqual({
      ok: true,
      file: {
        path: fs.realpathSync.native(path.join(ws, 'out', 'report.pdf')),
        name: 'report.pdf',
        size: 4,
        mime: 'application/pdf',
        kind: 'document',
        source: 'tool',
        identity: { dev: stat.dev, ino: stat.ino },
      },
    });
  });

  it('refuses a hard-linked file', () => {
    const file = write(path.join(ws, 'a.txt'));
    fs.linkSync(file, path.join(ws, 'b.txt'));
    expect(revalidate('b.txt')).toMatchObject({ ok: false, reason: 'hardlink' });
  });

  it('refuses a file in <deviaDir>/attachments — it is never a root', () => {
    const file = write(path.join(deviaDir, 'attachments', 'photo.png'));
    expect(revalidate(file)).toMatchObject({ ok: false, reason: 'outside_roots' });
  });

  it('refuses a symlink inside the workspace pointing at ~/.ssh/id_rsa', () => {
    const key = write(path.join(tmp, 'home', '.ssh', 'id_rsa'), 'PRIVATE');
    fs.symlinkSync(key, path.join(ws, 'notes.txt'));
    const result = revalidate('notes.txt');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).not.toContain('PRIVATE');
  });

  it('refuses .env.local inside the workspace', () => {
    write(path.join(ws, 'app', '.env.local'), 'TOKEN=1');
    expect(revalidate('app/.env.local')).toMatchObject({ ok: false, reason: 'secret' });
  });

  it('refuses a file from ANOTHER session worktree, even with this run in its own', () => {
    const own = path.join(deviaDir, 'worktrees', 'proj-key', 'sess-a');
    const foreign = write(path.join(deviaDir, 'worktrees', 'proj-key', 'sess-b', 'out.txt'));
    fs.mkdirSync(own, { recursive: true });
    write(path.join(own, 'mine.txt'));

    expect(revalidate('mine.txt', [ws, own], own).ok).toBe(true);
    expect(revalidate(foreign, [ws, own], own)).toMatchObject({ ok: false, reason: 'outside_roots' });
    expect(revalidate('../sess-b/out.txt', [ws, own], own)).toMatchObject({ ok: false, reason: 'outside_roots' });
  });

  it('prefers the forwarded absPath, so a forged one outside the roots is refused', () => {
    write(path.join(ws, 'ok.txt'));
    const outside = write(path.join(tmp, 'elsewhere.txt'));
    expect(revalidate('ok.txt', [ws], ws, { absPath: outside })).toMatchObject({ ok: false, reason: 'outside_roots' });
  });

  it('honours as:"document", and never turns a non-photo into a photo', () => {
    write(path.join(ws, 'shot.png'));
    write(path.join(ws, 'logo.svg'));
    expect(revalidate('shot.png')).toMatchObject({ ok: true, file: { kind: 'photo' } });
    expect(revalidate('shot.png', [ws], ws, { as: 'document' })).toMatchObject({ ok: true, file: { kind: 'document' } });
    expect(revalidate('logo.svg', [ws], ws, { as: 'photo' })).toMatchObject({ ok: true, file: { kind: 'document' } });
  });

  it('sends a photo over the photo cap as a document', () => {
    sparse(path.join(ws, 'huge.png'), 11 * 1024 * 1024);
    expect(revalidate('huge.png', [ws], ws, { as: 'photo' })).toMatchObject({ ok: true, file: { kind: 'document' } });
  });
});

describe('RunFileGate', () => {
  class Sink implements SendFileAuditSink {
    entries: Array<{ tool: string; summary?: string }> = [];
    append(entry: { tool: string; summary?: string }): void {
      this.entries.push(entry);
    }
  }
  const auditCtx = { agentId: 'claude', project: 'proj' };

  it('exposes the policy it was built with', () => {
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws });
    expect(gate.canSendFiles).toBe(true);
    expect(gate.sendRoots).toEqual([ws]);
    expect(gate.cwd).toBe(ws);
  });

  it('refuses everything when the run was not offered the tool', () => {
    write(path.join(ws, 'a.txt'));
    const log = new Sink();
    const gate = new RunFileGate({ canSendFiles: false, sendRoots: [ws], cwd: ws, audit: { log, ctx: auditCtx } });
    expect(gate.admit({ path: 'a.txt' }, 'tool')).toMatchObject({ ok: false, reason: 'not_offered' });
    expect(log.entries).toEqual([expect.objectContaining({ tool: SEND_FILE_AUDIT_TOOL, summary: 'rejected:not_offered' })]);
  });

  it('admits at most UI_LIMITS.sendFilesPerRun files per run — the 11th is refused', () => {
    for (let i = 0; i < 11; i++) write(path.join(ws, `f${i}.txt`));
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws });
    for (let i = 0; i < 10; i++) expect(gate.admit({ path: `f${i}.txt` }, 'tool').ok).toBe(true);
    expect(gate.admit({ path: 'f10.txt' }, 'tool')).toMatchObject({ ok: false, reason: 'limit' });
    expect(gate.count).toBe(10);
  });

  it.each(['tool', 'outbox'] as const)('puts the admitted identity into the %s RunFile', (source) => {
    const file = write(path.join(ws, 'outbox', 'a.txt'), 'abc');
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws });
    const stat = fs.lstatSync(file);
    expect(gate.admit({ path: file }, source)).toMatchObject({
      ok: true,
      file: { source, size: 3, identity: { dev: stat.dev, ino: stat.ino } },
    });
  });

  it("refuses Devia's data dir even when a send root contains it", () => {
    const inner = path.join(ws, '.devia-app');
    const transcript = write(path.join(inner, 'agent-logs', 'run.jsonl'));
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws, denyRoots: [inner] });
    expect(gate.admit({ path: transcript }, 'tool')).toMatchObject({ ok: false, reason: 'devia_data' });
  });

  it('disables sending when the only root is the home folder', () => {
    write(path.join(ws, 'a.txt'));
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws, homeDir: ws });
    expect(gate.admit({ path: 'a.txt' }, 'tool')).toMatchObject({ ok: false, reason: 'home_root' });
  });

  it('a refused file does not consume the quota', () => {
    write(path.join(ws, '.env'));
    write(path.join(ws, 'a.txt'));
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws, maxFiles: 1 });
    expect(gate.admit({ path: '.env' }, 'tool').ok).toBe(false);
    expect(gate.admit({ path: 'a.txt' }, 'tool').ok).toBe(true);
  });

  it('audits name + size only, never content or the absolute path', () => {
    write(path.join(ws, 'secret-content.txt'), 'TOP-SECRET-BODY');
    write(path.join(ws, '.env'), 'TOKEN=1');
    const log = new Sink();
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws, audit: { log, ctx: auditCtx } });
    gate.admit({ path: 'secret-content.txt' }, 'tool');
    gate.admit({ path: '.env' }, 'tool');

    expect(log.entries.map((e) => e.summary)).toEqual(['accepted secret-content.txt (15 B)', 'rejected:secret']);
    const dump = JSON.stringify(log.entries);
    expect(dump).not.toContain('TOP-SECRET-BODY');
    expect(dump).not.toContain(ws);
  });
});

describe('rebindArchivedRunFile', () => {
  function admitOutbox(file: string) {
    const gate = new RunFileGate({ canSendFiles: true, sendRoots: [ws], cwd: ws });
    const result = gate.admit({ path: file }, 'outbox');
    if (!result.ok) throw new Error(result.message);
    return result.file;
  }

  it('keeps the admitted identity across a rename (same inode)', () => {
    const src = write(path.join(ws, 'outbox', 'a.txt'), 'abc');
    const file = admitOutbox(src);
    const archived = path.join(deviaDir, 'outbox-archive', '1_a.txt');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.renameSync(src, archived);
    expect(rebindArchivedRunFile(file, archived)).toEqual({ ...file, path: archived, identity: file.identity });
  });

  it('re-binds to the copy when the archive move fell back to copy + unlink', () => {
    const src = write(path.join(ws, 'outbox', 'a.txt'), 'abc');
    const file = admitOutbox(src);
    const archived = path.join(deviaDir, 'outbox-archive', '1_a.txt');
    fs.mkdirSync(path.dirname(archived), { recursive: true });
    fs.cpSync(src, archived);
    const stat = fs.lstatSync(archived);
    fs.unlinkSync(src);
    expect(rebindArchivedRunFile(file, archived)).toMatchObject({
      path: archived,
      identity: { dev: stat.dev, ino: stat.ino },
    });
  });

  it('refuses an archive that no longer matches (size, links, missing)', () => {
    const src = write(path.join(ws, 'outbox', 'a.txt'), 'abc');
    const file = admitOutbox(src);
    fs.writeFileSync(src, 'abcdef');
    expect(rebindArchivedRunFile(file, src)).toBeNull();
    fs.writeFileSync(src, 'abc');
    fs.linkSync(src, path.join(ws, 'twin.txt'));
    expect(rebindArchivedRunFile(file, src)).toBeNull();
    expect(rebindArchivedRunFile(file, path.join(ws, 'missing.txt'))).toBeNull();
  });
});
