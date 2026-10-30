import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigRepository } from '../../../shared/ports';
import type { GitSyncResult } from '../../../../shared/domain/git';
import type { GitSyncer } from '../domain/ports';
import { detectDefaultBranchLocal } from './cli-git-inspector';
import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';

// Tail of the git stderr/stdout to surface in the toast if sync fails. Long
// enough to carry a useful error, short enough to stay readable.
const ERR_TAIL_LIMIT = 800;

export class CliGitSyncer implements GitSyncer {
  constructor(private readonly config: ConfigRepository) {}

  async sync(projectName: string): Promise<GitSyncResult> {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return { ok: false, message: 'Workspace no configurado.' };

    const cwd = path.join(workspaceRoot, projectName);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return { ok: false, message: 'El proyecto no es un repositorio git.' };
    }

    // Local detection first; if origin/HEAD isn't set, fall through to a
    // remote query so the one-shot user action still works even when the
    // cached symbolic ref is missing (which happens after `git init` +
    // `git remote add origin` without a `git clone` or `git fetch`).
    const branch = detectDefaultBranchLocal(cwd) ?? detectDefaultBranchRemote(cwd);
    if (!branch) {
      return { ok: false, message: 'No se pudo detectar la rama principal del repositorio.' };
    }

    try {
      execFileSyncOnPath('git', ['checkout', branch], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      execFileSyncOnPath('git', ['pull', '--ff-only'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, branch, message: `Sincronizado con ${branch}.` };
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message: string };
      const raw = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim();
      const tail = raw.slice(-ERR_TAIL_LIMIT);
      return { ok: false, branch, message: tail || 'Sync falló.' };
    }
  }

  async pull(projectName: string): Promise<GitSyncResult> {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return { ok: false, message: 'Workspace no configurado.' };

    // resolve (not join) so an absolute path is honoured as-is.
    const cwd = path.resolve(workspaceRoot, projectName);
    if (!fs.existsSync(path.join(cwd, '.git'))) {
      return { ok: false, message: 'El proyecto no es un repositorio git.' };
    }

    try {
      execFileSyncOnPath('git', ['pull', '--ff-only'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      return { ok: true, message: 'Pull completado.' };
    } catch (err) {
      const e = err as { stderr?: Buffer; stdout?: Buffer; message: string };
      const raw = (e.stderr?.toString() || e.stdout?.toString() || e.message).trim();
      const tail = raw.slice(-ERR_TAIL_LIMIT);
      return { ok: false, message: tail || 'Pull falló.' };
    }
  }
}

// Remote fallback: queries origin without a full fetch. Slow (network), so
// only called from the user-triggered sync action — never from info().
function detectDefaultBranchRemote(cwd: string): string | null {
  try {
    const out = execFileSyncOnPath('git', ['ls-remote', '--symref', 'origin', 'HEAD'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
    const match = out.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD/m);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
