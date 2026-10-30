import { describe, it, expect } from 'vitest';
import { buildIdeSpawn, ideCandidates, availableIdes, IDE_CATALOG } from '../../../shared/domain/ide';

describe('ide catalog helpers', () => {
  it('builds a macOS `open -a` spawn that waits for the exit code', () => {
    expect(buildIdeSpawn('Visual Studio Code', '/Users/me/proj', 'mac')).toEqual({
      cmd: '/usr/bin/open',
      args: ['-a', 'Visual Studio Code', '/Users/me/proj'],
      useShell: false,
      waitForExit: true,
    });
  });

  it('runs the Windows PATH command through a shell and quotes spaced paths', () => {
    expect(buildIdeSpawn('code', 'C:\\My Projects\\app', 'win')).toEqual({
      cmd: 'code',
      args: ['"C:\\My Projects\\app"'],
      useShell: true,
      waitForExit: false,
    });
  });

  it('leaves space-free Windows paths unquoted', () => {
    expect(buildIdeSpawn('code', 'C:\\proj', 'win').args).toEqual(['C:\\proj']);
  });

  it('spawns the Linux PATH command directly without a shell', () => {
    expect(buildIdeSpawn('code', '/home/me/proj', 'linux')).toEqual({
      cmd: 'code',
      args: ['/home/me/proj'],
      useShell: false,
      waitForExit: false,
    });
  });

  it('returns per-OS launch candidates in preference order', () => {
    const zed = IDE_CATALOG.find((spec) => spec.id === 'zed');
    expect(zed && ideCandidates(zed, 'mac')).toEqual(['Zed']);
    expect(zed && ideCandidates(zed, 'linux')).toEqual(['zed', 'zeditor']);
  });

  it('filters the catalog to resolved IDEs, preserving catalog order', () => {
    expect(availableIdes({ cursor: 'cursor', vscode: 'code', zed: null })).toEqual([
      { id: 'vscode', label: 'VS Code' },
      { id: 'cursor', label: 'Cursor' },
    ]);
  });

  it('ignores empty-string launch handles', () => {
    expect(availableIdes({ vscode: '' })).toEqual([]);
  });
});
