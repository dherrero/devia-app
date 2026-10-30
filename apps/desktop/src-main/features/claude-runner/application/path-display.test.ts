import { describe, it, expect } from 'vitest';
import { toRelativePath } from '../../../../shared/domain/path-display';

describe('toRelativePath', () => {
  it('AC1: strips POSIX workspace prefix and normalises to forward slashes', () => {
    const result = toRelativePath('/workspace/project/src/app/button.ts', '/workspace/project');
    expect(result).toBe('src/app/button.ts');
  });

  it('AC1: strips Windows workspace prefix and normalises backslashes', () => {
    const result = toRelativePath('G:\\saaaaaaas\\project\\src\\app\\button.ts', 'G:\\saaaaaaas\\project');
    expect(result).toBe('src/app/button.ts');
  });

  it('AC1: handles trailing separator on workspace root', () => {
    const result = toRelativePath('/ws/project/src/index.ts', '/ws/project/');
    expect(result).toBe('src/index.ts');
  });

  it('AC2: returns normalised absolute path when file is outside workspace', () => {
    const result = toRelativePath('/tmp/outside/file.ts', '/workspace/project');
    expect(result).toBe('/tmp/outside/file.ts');
  });

  it('AC3: empty workspaceRoot returns normalised input', () => {
    const result = toRelativePath('/workspace/project/src/app.ts', '');
    expect(result).toBe('/workspace/project/src/app.ts');
  });

  it('normalises backslashes even for out-of-workspace paths', () => {
    const result = toRelativePath('C:\\Windows\\System32\\file.txt', 'G:\\project');
    expect(result).toBe('C:/Windows/System32/file.txt');
  });
});
