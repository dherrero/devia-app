import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathRefusedError, readSourceRange } from './source-reader';

let root: string;
let outside: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-src-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-src-out-'));
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'one\ntwo\nthree\nfour\n');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret\n');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

function refused(rel: string): void {
  try {
    readSourceRange(root, rel, 1, 5);
  } catch (e) {
    expect(e).toBeInstanceOf(PathRefusedError);
    expect((e as PathRefusedError).code).toBe('PATH_REFUSED');
    return;
  }
  throw new Error(`expected PATH_REFUSED for ${rel}`);
}

describe('readSourceRange', () => {
  it('reads an inclusive 1-based range', () => {
    expect(readSourceRange(root, 'src/a.ts', 2, 3)).toBe('two\nthree');
  });

  it('normalises CRLF to LF', () => {
    fs.writeFileSync(path.join(root, 'crlf.ts'), 'a\r\nb\r\nc\r\n');
    expect(readSourceRange(root, 'crlf.ts', 1, 3)).toBe('a\nb\nc');
  });

  it('refuses traversal, absolute, NUL and drive/UNC paths', () => {
    refused('../../etc/passwd');
    refused('src/../../x');
    refused(path.join(outside, 'secret.txt'));
    refused('src/a.ts\0.png');
    refused('C:\\Windows\\win.ini');
    refused('\\\\server\\share\\f.ts');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink that points outside the root',
    () => {
      fs.symlinkSync(outside, path.join(root, 'link'));
      refused('link/secret.txt');
      fs.symlinkSync(
        path.join(outside, 'secret.txt'),
        path.join(root, 'file-link.ts'),
      );
      refused('file-link.ts');
    },
  );

  it('returns a note for a vanished file instead of throwing', () => {
    expect(readSourceRange(root, 'src/gone.ts', 1, 3)).toContain(
      'file not found or changed since indexing — run graph_status',
    );
  });

  it('returns a note above the 2 MB cap', () => {
    fs.writeFileSync(path.join(root, 'big.ts'), 'x\n'.repeat(1_600_000));
    const out = readSourceRange(root, 'big.ts', 1, 3);
    expect(out).toContain('file too large');
    expect(out).not.toContain('x\nx');
  });

  it('caps a range at 400 lines', () => {
    fs.writeFileSync(
      path.join(root, 'long.ts'),
      Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join('\n'),
    );
    const out = readSourceRange(root, 'long.ts', 1, 1000);
    expect(out).toContain('l400');
    expect(out).not.toContain('l401\n');
    expect(out).toContain('truncated');
  });
});
