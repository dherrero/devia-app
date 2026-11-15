import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  PathRefusedError,
  createSourceReader,
  readSourceRange,
} from './source-reader';

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

  it('strips a UTF-8 BOM', () => {
    fs.writeFileSync(path.join(root, 'bom.ts'), '\uFEFFfirst\nsecond\n');
    expect(readSourceRange(root, 'bom.ts', 1, 1)).toBe('first');
  });
});

describe('createSourceReader', () => {
  it('reads a file once and reports the lines actually shown', () => {
    const reader = createSourceReader(root);
    const first = reader.read('src/a.ts', 1, 2);
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'changed\n');
    const second = reader.read('src/a.ts', 3, 4);
    expect(first).toMatchObject({ ok: true, text: 'one\ntwo', endLine: 2 });
    expect(second).toMatchObject({ ok: true, text: 'three\nfour' });
  });

  it('reports lines beyond the 400 cap and never throws on a refused path', () => {
    fs.writeFileSync(
      path.join(root, 'long.ts'),
      Array.from({ length: 1000 }, (_, i) => `l${i + 1}`).join('\n'),
    );
    const reader = createSourceReader(root);
    expect(reader.read('long.ts', 10, 900)).toMatchObject({
      ok: true,
      endLine: 409,
      moreLines: 491,
    });
    expect(reader.read('../../etc/passwd', 1, 2)).toMatchObject({
      ok: false,
      note: 'path outside the project root — skipped',
    });
  });
});
