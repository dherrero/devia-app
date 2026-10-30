import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorkspaceBoundary } from './workspace-boundary';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'wb-test-'));
}

describe('WorkspaceBoundary', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots) {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    roots.length = 0;
  });

  function setup(): { root: string; boundary: ReturnType<typeof createWorkspaceBoundary> } {
    const root = tmpDir();
    roots.push(root);
    return { root, boundary: createWorkspaceBoundary(root) };
  }

  // AC1: path that resolves outside workspace
  it('returns escape for path outside workspace (AC1)', () => {
    const { boundary } = setup();
    const result = boundary.resolve('../outside');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('escape');
  });

  it('returns escape for absolute path traversal with ..', () => {
    const { root, boundary } = setup();
    // Absolute path to parent directory
    const outside = path.dirname(root);
    const result = boundary.resolve(outside);
    expect(result.ok).toBe(false);
  });

  it('returns ok for path inside workspace', () => {
    const { root, boundary } = setup();
    const inside = path.join(root, 'src');
    fs.mkdirSync(inside, { recursive: true });
    const result = boundary.resolve(path.join('src'));
    expect(result.ok).toBe(true);
  });

  it('returns ok for the workspace root itself', () => {
    const { root, boundary } = setup();
    const result = boundary.resolve(root);
    expect(result.ok).toBe(true);
  });

  it('returns not_found for non-existent path inside workspace', () => {
    const { boundary } = setup();
    const result = boundary.resolve('nonexistent/deep/file.txt');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('not_found');
  });

  // AC2: symlink pointing outside (skip on Windows — requires elevation)
  it('returns symlink_escape for symlink pointing outside workspace (AC2)', { skip: process.platform === 'win32' }, () => {
    const { root, boundary } = setup();

    // Create a real outside directory
    const outside = tmpDir();
    roots.push(outside);
    const outsideFile = path.join(outside, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf8');

    // Create symlink inside workspace pointing to outside directory
    const symlink = path.join(root, 'link');
    fs.symlinkSync(outside, symlink);

    const result = boundary.resolve('link');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('symlink_escape');
  });

  it('exposes root as absolute resolved path', () => {
    const { root, boundary } = setup();
    expect(path.isAbsolute(boundary.root)).toBe(true);
    expect(boundary.root).toBe(path.resolve(root));
  });

  it('handles Windows drive-letter paths correctly', () => {
    // This test verifies the boundary does not crash on the current platform
    const { root, boundary } = setup();
    const nested = path.join(root, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    const result = boundary.resolve(path.join('a', 'b'));
    expect(result.ok).toBe(true);
  });
});
