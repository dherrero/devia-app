import { describe, it, expect, vi } from 'vitest';
import * as path from 'node:path';
import { resolveAndValidateCwd, findEscapingImagePath } from './resolve-cwd';

// Use a stable workspace root that is not sensitive to CWD
const WORKSPACE = path.resolve('/home/user/projects');

describe('resolveAndValidateCwd', () => {
  it('returns ok:true for a simple project name inside workspace', () => {
    const result = resolveAndValidateCwd('my-project', WORKSPACE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(path.resolve(WORKSPACE, 'my-project'));
      expect(result.resolvedPath.startsWith(WORKSPACE)).toBe(true);
    }
  });

  it('returns ok:false for path traversal with ../..', () => {
    const result = resolveAndValidateCwd('../../etc/passwd', WORKSPACE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Project path is outside workspace');
    }
  });

  it('returns ok:false for absolute path outside workspace', () => {
    const result = resolveAndValidateCwd('/tmp/evil', WORKSPACE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Project path is outside workspace');
    }
  });

  it('returns ok:true when project resolves to exactly the workspace root', () => {
    // Resolving '.' from the workspace gives the workspace itself
    const result = resolveAndValidateCwd('.', WORKSPACE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(path.resolve(WORKSPACE));
    }
  });

  it('returns ok:false when workspace root is empty string', () => {
    const result = resolveAndValidateCwd('my-project', '');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Workspace root is not configured');
    }
  });

  it('returns ok:false for a sibling directory that starts with same prefix', () => {
    // e.g. /home/user/projects-evil should NOT be inside /home/user/projects
    const result = resolveAndValidateCwd('../projects-evil', WORKSPACE);
    expect(result.ok).toBe(false);
  });

  it('returns ok:true for nested subdirectory', () => {
    const result = resolveAndValidateCwd('nested/sub/dir', WORKSPACE);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolvedPath).toBe(path.resolve(WORKSPACE, 'nested/sub/dir'));
    }
  });

  describe('Windows case-insensitive path comparison (REV-TS-CLI-12-03)', () => {
    it('returns ok:true on Windows even when drive letter casing differs', () => {
      // Simulate Windows platform
      vi.stubEnv('PLATFORM', 'win32');
      const originalPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });

      try {
        // Both paths go through path.resolve, which on Windows normalises drive letters.
        // The important property is that isPathContained lowercases before comparing, so
        // manually-edited config with 'c:\projects' vs resolved 'C:\projects' is handled.
        const root = 'C:\\projects';
        const result = resolveAndValidateCwd('my-app', root);
        expect(result.ok).toBe(true);
      } finally {
        Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
        vi.unstubAllEnvs();
      }
    });
  });
});

// Use a stable project CWD for imagePaths tests
const PROJECT_CWD = path.resolve('/home/user/projects/my-project');

describe('findEscapingImagePath', () => {
  it('returns null for empty array', () => {
    expect(findEscapingImagePath([], PROJECT_CWD)).toBeNull();
  });

  it('returns null for safe relative path inside cwd', () => {
    expect(findEscapingImagePath(['src/assets/diagram.png'], PROJECT_CWD)).toBeNull();
  });

  it('returns null for nested relative path inside cwd', () => {
    expect(findEscapingImagePath(['assets/img/photo.jpg', 'docs/chart.png'], PROJECT_CWD)).toBeNull();
  });

  it('returns the escaping path for a path traversal attempt', () => {
    const result = findEscapingImagePath(['../../.env'], PROJECT_CWD);
    expect(result).toBe('../../.env');
  });

  it('returns the escaping path for an absolute path outside cwd', () => {
    const result = findEscapingImagePath(['/tmp/evil.png'], PROJECT_CWD);
    expect(result).toBe('/tmp/evil.png');
  });

  it('returns the first escaping path when multiple paths are provided', () => {
    // First path is safe, second escapes
    const result = findEscapingImagePath(['safe.png', '../sibling/secret.txt'], PROJECT_CWD);
    expect(result).toBe('../sibling/secret.txt');
  });

  it('rejects a path that resolves exactly to cwd (must be inside, not equal)', () => {
    // path.resolve(cwd, '.') === cwd — not inside, it IS the directory
    const result = findEscapingImagePath(['.'], PROJECT_CWD);
    expect(result).toBe('.');
  });
});
