import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { shell } from 'electron';
import type { ProjectFileSystem } from '../domain/ports';
import { ensureAgentDefaults as writeAgentDefaults } from '../../../shared/agent-defaults';
import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';

function expandPath(p: string): string {
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

export class NodeProjectFileSystem implements ProjectFileSystem {
  exists(absPath: string): boolean {
    return fs.existsSync(absPath);
  }

  mkdirRecursive(absPath: string): void {
    fs.mkdirSync(absPath, { recursive: true });
  }

  rename(absFrom: string, absTo: string): void {
    fs.renameSync(absFrom, absTo);
  }

  rmRecursive(absPath: string): void {
    fs.rmSync(absPath, { recursive: true, force: true });
  }

  copyTreeWithoutGit(absFrom: string, absTo: string): void {
    fs.cpSync(absFrom, absTo, { recursive: true });
    const gitDir = path.join(absTo, '.git');
    if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
  }

  gitCloneAndReinit(repository: string, absTo: string): void {
    const parent = path.dirname(absTo);
    const name = path.basename(absTo);
    fs.mkdirSync(parent, { recursive: true });
    execFileSyncOnPath('git', ['clone', repository, name], {
      cwd: parent,
      stdio: 'ignore',
    });
    const gitDir = path.join(absTo, '.git');
    if (fs.existsSync(gitDir)) fs.rmSync(gitDir, { recursive: true, force: true });
    execFileSyncOnPath('git', ['init'], { cwd: absTo, stdio: 'ignore' });
  }

  applyBaseCopyEntry(
    absProjectRoot: string,
    entry: { from: string; to: string; exclude?: string[]; flatten?: boolean },
  ): boolean {
    const src = expandPath(entry.from);
    const dest = path.join(absProjectRoot, entry.to);
    if (!fs.existsSync(src)) return false;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const stat = fs.statSync(src);
    if (stat.isFile()) {
      fs.copyFileSync(src, dest);
      return true;
    }
    if (entry.flatten) {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(src, dest, { recursive: true });
    } else {
      fs.cpSync(src, dest, { recursive: true });
    }
    for (const excluded of entry.exclude ?? []) {
      const excludedPath = path.join(dest, excluded);
      if (fs.existsSync(excludedPath)) fs.rmSync(excludedPath, { recursive: true, force: true });
    }
    return true;
  }

  gitInit(absPath: string): void {
    try {
      execFileSyncOnPath('git', ['init'], { cwd: absPath, stdio: 'ignore' });
    } catch {
      // Swallow: missing git binary shouldn't block project creation.
    }
  }

  gitInitAndFirstCommit(absPath: string, message: string): void {
    execFileSyncOnPath('git', ['init'], { cwd: absPath, stdio: 'ignore' });
    execFileSyncOnPath('git', ['add', '.'], { cwd: absPath, stdio: 'ignore' });
    execFileSyncOnPath('git', ['commit', '-m', message], { cwd: absPath, stdio: 'ignore' });
  }

  ensureAgentDefaults(absPath: string): void {
    writeAgentDefaults(absPath);
  }

  async trash(absPath: string): Promise<void> {
    await shell.trashItem(absPath);
  }
}
