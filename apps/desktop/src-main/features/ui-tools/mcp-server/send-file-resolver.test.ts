import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { UI_LIMITS, type UiToolName } from '../../../../shared/domain/ui-tools';
import { readUiRequest, requestFilePath } from '../../../shared/ui-rendezvous';
import { makeSendFileResolver } from './send-file-resolver';
import { callUiTool, type UiToolDeps } from './ui-tools-call';

let tmp = '';
let ws = '';
let uiDir = '';
let counter = 0;

function deps(overrides: Partial<UiToolDeps> = {}, roots: string[] = [ws]): UiToolDeps {
  return {
    uiDir,
    timeoutMs: 100,
    pollIntervalMs: 5,
    advertised: ['send_file', 'todo'] as UiToolName[],
    newCallId: () => `call-${++counter}`,
    resolveLocally: makeSendFileResolver({ cwd: ws, roots }),
    ...overrides,
  };
}

function write(rel: string, content = 'x', base = ws): string {
  const file = path.join(base, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function sparse(rel: string, bytes: number): void {
  const fd = fs.openSync(path.join(ws, rel), 'w');
  fs.ftruncateSync(fd, bytes);
  fs.closeSync(fd);
}

function requests(): unknown[] {
  return fs
    .readdirSync(uiDir)
    .filter((f) => f.endsWith('.request.json'))
    .map((f) => readUiRequest(path.join(uiDir, f))?.toolInput);
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-send-'));
  ws = path.join(tmp, 'ws');
  uiDir = path.join(tmp, 'ui');
  fs.mkdirSync(ws);
  fs.mkdirSync(uiDir);
  counter = 0;
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('devia_send_file resolved locally', () => {
  it('forwards a relative path enriched, with the specific ack', async () => {
    write('out/report.pdf', 'pdf-bytes');
    const result = await callUiTool(deps(), 'devia_send_file', { path: 'out/report.pdf', caption: 'Here' });

    expect(result).toEqual({
      text: "Queued: report.pdf (9 B) will be sent to the user's chat after your reply. Do not paste its content.",
    });
    const request = readUiRequest(requestFilePath(uiDir, 'call-1'));
    expect(request).toMatchObject({ tool: 'send_file', expectsAnswer: false });
    expect(request?.toolInput).toEqual({
      path: 'out/report.pdf',
      absPath: fs.realpathSync.native(path.join(ws, 'out/report.pdf')),
      name: 'report.pdf',
      size: 9,
      mime: 'application/pdf',
      caption: 'Here',
      as: 'auto',
    });
  });

  it('accepts an absolute path inside the root', async () => {
    const file = write('a.png');
    const result = await callUiTool(deps(), 'devia_send_file', { path: file, as: 'photo' });
    expect(result.isError).toBeUndefined();
    expect(requests()[0]).toMatchObject({ as: 'photo', mime: 'image/png' });
  });

  it.each([
    ['../outside.txt', 'outside the allowed folders'],
    ['.env', 'secret/credential'],
    ['dir', 'not a regular file'],
    ['missing.txt', 'not found'],
  ])('refuses %s without touching the rendezvous', async (rel, message) => {
    write('outside.txt', 'x', tmp);
    write('.env', 'TOKEN=1');
    fs.mkdirSync(path.join(ws, 'dir'));
    const result = await callUiTool(deps(), 'devia_send_file', { path: rel });
    expect(result.isError).toBe(true);
    expect(result.text).toContain(message);
    expect(result.text).not.toContain('TOKEN');
    expect(requests()).toHaveLength(0);
  });

  it('refuses a symlink pointing outside the root', async () => {
    fs.symlinkSync(write('x.txt', 'x', tmp), path.join(ws, 'link.txt'));
    const result = await callUiTool(deps(), 'devia_send_file', { path: 'link.txt' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('outside the allowed folders');
  });

  it('refuses a 60 MB file with its size and a suggestion', async () => {
    sparse('big.mov', 60 * 1024 * 1024);
    const result = await callUiTool(deps(), 'devia_send_file', { path: 'big.mov' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('60 MB');
    expect(result.text).toMatch(/compress/i);
  });

  it('downgrades a photo over 10 MB to a document instead of failing', async () => {
    sparse('huge.png', 11 * 1024 * 1024);
    const result = await callUiTool(deps(), 'devia_send_file', { path: 'huge.png', as: 'photo' });
    expect(result.isError).toBeUndefined();
    expect(requests()[0]).toMatchObject({ as: 'document' });
  });

  it(`rejects file number ${UI_LIMITS.sendFilesPerRun + 1}, counting only queued ones`, async () => {
    write('a.txt');
    const d = deps();
    // A refusal does not consume the budget.
    expect((await callUiTool(d, 'devia_send_file', { path: 'nope.txt' })).isError).toBe(true);
    for (let i = 0; i < UI_LIMITS.sendFilesPerRun; i++) {
      expect((await callUiTool(d, 'devia_send_file', { path: 'a.txt' })).isError).toBeUndefined();
    }
    const over = await callUiTool(d, 'devia_send_file', { path: 'a.txt' });
    expect(over.isError).toBe(true);
    expect(over.text).toContain(`at most ${UI_LIMITS.sendFilesPerRun}`);
    expect(requests()).toHaveLength(UI_LIMITS.sendFilesPerRun);
  });

  it.each([[{}], [{ path: 42 }], [null], [{ path: '' }]])('rejects invalid args %j', async (args) => {
    const result = await callUiTool(deps(), 'devia_send_file', args);
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Expected { path');
  });

  it("refuses Devia's data dir passed as --deny-roots, even inside the root", async () => {
    const deviaDir = path.join(ws, '.devia-app');
    write('memory/store.json', '{}', deviaDir);
    const d = deps({ resolveLocally: makeSendFileResolver({ cwd: ws, roots: [ws], denyRoots: [deviaDir] }) });
    const result = await callUiTool(d, 'devia_send_file', { path: '.devia-app/memory/store.json' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain("Devia's private data folder");
    expect(requests()).toHaveLength(0);
  });

  it('refuses everything when the root is the home folder', async () => {
    write('a.txt');
    const d = deps({ resolveLocally: makeSendFileResolver({ cwd: ws, roots: [ws], homeDir: ws }) });
    const result = await callUiTool(d, 'devia_send_file', { path: 'a.txt' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('home folder');
  });

  it('refuses a hard-linked file and .envrc', async () => {
    fs.linkSync(write('a.txt'), path.join(ws, 'b.txt'));
    write('.envrc', 'export TOKEN=1');
    expect((await callUiTool(deps(), 'devia_send_file', { path: 'b.txt' })).text).toContain('multiple hard links');
    expect((await callUiTool(deps(), 'devia_send_file', { path: '.envrc' })).text).toContain('secret');
    expect(requests()).toHaveLength(0);
  });

  it('refuses when the run gave no roots', async () => {
    write('a.txt');
    const result = await callUiTool(deps({}, []), 'devia_send_file', { path: 'a.txt' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('not configured');
  });

  it('a non-advertised send_file still gets the standard refusal', async () => {
    write('a.txt');
    const result = await callUiTool(deps({ advertised: ['todo'] }), 'devia_send_file', { path: 'a.txt' });
    expect(result).toMatchObject({ isError: true });
    expect(result.text).toContain('is not available in this run');
    expect(requests()).toHaveLength(0);
  });

  it('leaves other tools alone', async () => {
    const result = await callUiTool(deps(), 'devia_todo', { items: [{ text: 'a' }] });
    expect(result.text).toBe('Recorded.');
  });
});
