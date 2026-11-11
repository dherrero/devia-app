import { describe, expect, it } from 'vitest';

import { graphAbsolutePath } from './project-path';

describe('graphAbsolutePath', () => {
  it('joins the workspace root, the project key and the graph path', () => {
    expect(graphAbsolutePath('/ws', 'proj', 'src/a.ts')).toBe('/ws/proj/src/a.ts');
    expect(graphAbsolutePath('/ws/', 'proj', '')).toBe('/ws/proj');
  });

  it('keeps an absolute project key as it is, POSIX or Windows', () => {
    expect(graphAbsolutePath('/ws', '/elsewhere/proj', 'a.ts')).toBe('/elsewhere/proj/a.ts');
    expect(graphAbsolutePath('C:\\ws', 'D:\\code\\proj', 'src/a.ts')).toBe('D:\\code\\proj/src/a.ts');
    expect(graphAbsolutePath('C:\\ws\\', 'proj', 'src/a.ts')).toBe('C:\\ws/proj/src/a.ts');
  });

  it('works without a workspace root', () => {
    expect(graphAbsolutePath(null, 'proj', 'a.ts')).toBe('proj/a.ts');
  });
});
