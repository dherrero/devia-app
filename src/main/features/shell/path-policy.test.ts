import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { decideShellPath } from './path-policy';

let base: string;
let ws: string;
let outside: string;

beforeAll(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'shell-policy-')));
  ws = path.join(base, 'ws');
  outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'Evil.app'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(ws, 'pic.png'), 'x');
  fs.writeFileSync(path.join(ws, 'run.command'), '#!/bin/sh');
  fs.writeFileSync(path.join(outside, 'pic.png'), 'x');
  fs.symlinkSync(path.join(outside, 'pic.png'), path.join(ws, 'link.png'));
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe('decideShellPath', () => {
  it('opens media inside a root', () => {
    expect(decideShellPath(path.join(ws, 'pic.png'), [ws])).toEqual({
      action: 'open',
      path: path.join(ws, 'pic.png'),
    });
  });
  it('reveals instead of opening non-media files', () => {
    expect(decideShellPath(path.join(ws, 'run.command'), [ws]).action).toBe('reveal');
  });
  it('opens plain folders but reveals launchable bundles', () => {
    expect(decideShellPath(path.join(ws, 'sub'), [ws]).action).toBe('open');
    expect(decideShellPath(path.join(ws, 'Evil.app'), [ws]).action).toBe('reveal');
  });
  it('denies paths outside the roots, traversal and symlink escapes', () => {
    expect(decideShellPath(path.join(outside, 'pic.png'), [ws]).action).toBe('deny');
    expect(decideShellPath(path.join(ws, '..', 'outside', 'pic.png'), [ws]).action).toBe('deny');
    expect(decideShellPath(path.join(ws, 'link.png'), [ws]).action).toBe('deny');
  });
  it('denies missing, relative and non-string input', () => {
    expect(decideShellPath(path.join(ws, 'nope.png'), [ws]).action).toBe('deny');
    expect(decideShellPath('pic.png', [ws]).action).toBe('deny');
    expect(decideShellPath(undefined, [ws]).action).toBe('deny');
  });
});
