import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';
import type { ConfigRepository } from '../../../shared/ports';
import type {
  BranchRef,
  BranchCheckoutRef,
  CheckoutResult,
} from '../../../../shared/domain/git';
import type { GitBrancher } from '../domain/ports';

// Tail of the git stderr/stdout surfaced in the toast when a checkout fails.
// Long enough to carry a useful error, short enough to stay readable.
const ERR_TAIL_LIMIT = 800;

// One for-each-ref walk yields local + remote branches with everything the
// switcher needs. Fields are NUL-separated so a commit subject can carry any
// character (spaces, pipes) without breaking the parse.
const NUL = '\x00';
const FOR_EACH_REF_FORMAT = [
  '%(refname)',
  '%(objectname:short)',
  '%(HEAD)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(committerdate:unix)',
  '%(contents:subject)',
].join('%00');

/**
 * Runs git and returns stdout as a string. Injected so the unit tests drive
 * the brancher without shelling out to a real git (mirrors how the rest of
 * the feature would, but `CliGitInspector` hard-binds the helper — here we
 * keep it injectable for testability).
 */
export type ExecRunner = (args: string[], cwd: string) => string;

const realExec: ExecRunner = (args, cwd) =>
  execFileSyncOnPath('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

export class CliGitBrancher implements GitBrancher {
  constructor(
    private readonly config: ConfigRepository,
    private readonly exec: ExecRunner = realExec,
  ) {}

  private resolveCwd(projectName: string): string | null {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return null;
    // resolve (not join) so an absolute path is used as-is while a
    // workspace-relative name still resolves under the workspace.
    const cwd = path.resolve(workspaceRoot, projectName);
    if (!fs.existsSync(path.join(cwd, '.git'))) return null;
    return cwd;
  }

  async list(projectName: string): Promise<BranchRef[]> {
    const cwd = this.resolveCwd(projectName);
    if (!cwd) return [];
    try {
      const raw = this.exec(
        ['for-each-ref', '--sort=-committerdate', `--format=${FOR_EACH_REF_FORMAT}`, 'refs/heads', 'refs/remotes'],
        cwd,
      );
      return parseBranches(raw);
    } catch {
      return [];
    }
  }

  async checkout(projectName: string, ref: BranchCheckoutRef): Promise<CheckoutResult> {
    const { workspaceRoot } = this.config.get();
    if (!workspaceRoot) return { ok: false, message: 'Workspace no configurado.' };
    const cwd = this.resolveCwd(projectName);
    if (!cwd) return { ok: false, message: 'El proyecto no es un repositorio git.' };

    const { args, branch } = this.buildCheckoutArgs(ref, cwd);
    try {
      this.exec(args, cwd);
      return { ok: true, branch, message: `Cambiado a ${branch}.` };
    } catch (err) {
      const e = err as { stderr?: Buffer | string; stdout?: Buffer | string; message?: string };
      const raw = (e.stderr?.toString() || e.stdout?.toString() || e.message || '').trim();
      const tail = raw.slice(-ERR_TAIL_LIMIT);
      return { ok: false, branch, message: tail || 'No se pudo cambiar de rama.' };
    }
  }

  private buildCheckoutArgs(ref: BranchCheckoutRef, cwd: string): { args: string[]; branch: string } {
    // Local branch: plain checkout. NEVER -f/--force/-B — git aborts cleanly
    // on a conflicting dirty tree and we surface that, no data loss.
    if (!ref.isRemote) {
      return { args: ['checkout', ref.name], branch: ref.name };
    }
    // Remote branch ("origin/dev"): the local branch name drops the remote.
    const slash = ref.name.indexOf('/');
    const localName = slash >= 0 ? ref.name.slice(slash + 1) : ref.name;
    if (this.localBranchExists(localName, cwd)) {
      return { args: ['checkout', localName], branch: localName };
    }
    // No local tracking branch yet → create one tracking the remote.
    return { args: ['checkout', '--track', ref.name], branch: localName };
  }

  private localBranchExists(localName: string, cwd: string): boolean {
    try {
      this.exec(['show-ref', '--verify', '--quiet', `refs/heads/${localName}`], cwd);
      return true;
    } catch {
      return false;
    }
  }
}

function parseBranches(raw: string): BranchRef[] {
  const out: BranchRef[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const [refname, shortSha, head, upstreamShort, upstreamTrack, ts, subject] = line.split(NUL);
    if (refname === undefined) continue;

    const isRemote = refname.startsWith('refs/remotes/');
    // Skip the symbolic remote pointer (refs/remotes/origin/HEAD) — not a branch.
    if (isRemote && refname.endsWith('/HEAD')) continue;

    const name = isRemote
      ? refname.slice('refs/remotes/'.length)
      : refname.slice('refs/heads/'.length);

    const track = upstreamTrack ?? '';
    const aheadMatch = /ahead (\d+)/.exec(track);
    const behindMatch = /behind (\d+)/.exec(track);

    const branch: BranchRef = {
      name,
      isRemote,
      isCurrent: head === '*',
      shortSha: shortSha ?? '',
      lastCommitTs: Number.parseInt(ts ?? '', 10) || 0,
      subject: subject ?? '',
      ...(!isRemote && upstreamShort ? { upstream: upstreamShort } : {}),
      ...(aheadMatch ? { ahead: Number.parseInt(aheadMatch[1]!, 10) } : {}),
      ...(behindMatch ? { behind: Number.parseInt(behindMatch[1]!, 10) } : {}),
      ...(/\[gone\]/.test(track) ? { upstreamGone: true } : {}),
    };
    out.push(branch);
  }
  return out;
}
