import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Source-handling primitives shared by the discoverer (clones to a temp
 * for the picker) and the installer (clones into the persistent cache).
 *
 * The installer reuses an already-discovered temp dir whenever possible
 * to avoid double-cloning, but if the user typed a specific skill name
 * and skipped the picker we still need a way to materialise the source
 * — that's also why this module exists separately from either consumer.
 */

const CLONE_TIMEOUT_MS = 2 * 60 * 1000;

export interface MaterialisedSource {
  /**
   * Root we hand to the scanner / installer. For local-path sources this
   * is the source itself; for remote sources it's `<tempDir>/<sub>` if
   * the URL pointed at a subtree, otherwise the temp dir.
   */
  scanRoot: string;
  /** The actual temp dir we created (or '' if local). Used for cleanup. */
  tempDir: string;
  /** Whether the source is on the user's machine (no clone happened). */
  isLocal: boolean;
}

/**
 * Cache key derivation. Same source string → same key, so two projects
 * that install from `vercel-labs/agent-skills` share one cache entry.
 *
 *   owner/repo (GitHub shorthand)        → owner-repo
 *   https://github.com/owner/repo[.git]  → owner-repo
 *   ssh git@github.com:owner/repo[.git]  → owner-repo
 *   gitlab/bitbucket/etc                 → host-owner-repo
 *   local path                           → local-<sha1>
 *   anything else                        → url-<sha1>
 */
export function deriveCacheKey(source: string): string {
  const s = source.trim();

  if (/^[\w.-]+\/[\w.-]+$/.test(s)) {
    return sanitiseKey(s.replace('/', '-'));
  }

  const ghTree = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/.*)?\/?$/.exec(s);
  if (ghTree) return sanitiseKey(`${ghTree[1]}-${ghTree[2]}`);

  const httpsHost = /^https?:\/\/([^/]+)\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/.*)?\/?$/.exec(s);
  if (httpsHost) {
    const host = httpsHost[1]?.replace(/\.[a-z]+$/i, '') ?? 'host';
    return sanitiseKey(`${host}-${httpsHost[2]}-${httpsHost[3]}`);
  }

  const ssh = /^[\w.-]+@([\w.-]+):([\w.-]+)\/([\w.-]+?)(?:\.git)?$/.exec(s);
  if (ssh) {
    const host = ssh[1]?.replace(/\.[a-z]+$/i, '') ?? 'host';
    return sanitiseKey(`${host}-${ssh[2]}-${ssh[3]}`);
  }

  if (looksLikeLocalPath(s)) {
    return `local-${sha1(path.resolve(s)).slice(0, 12)}`;
  }

  return `url-${sha1(s).slice(0, 12)}`;
}

export function looksLikeLocalPath(source: string): boolean {
  if (source.startsWith('./') || source.startsWith('../')) return true;
  if (source.startsWith('~')) return true;
  if (path.isAbsolute(source)) return true;
  if (/^[A-Za-z]:[\\/]/.test(source)) return true;
  return false;
}

/**
 * Materialise the source on disk so callers can scan or copy from it.
 *
 * For local paths nothing is copied — we hand back the absolute path.
 * For remote sources we shallow-clone into a fresh OS temp dir; the
 * caller decides when to remove it (via `cleanup`).
 *
 * GitHub tree URLs (`…/tree/<branch>/<sub>`) are honoured: we clone the
 * repo without the tree suffix and `scanRoot` points at the subtree.
 */
export async function materialiseSource(source: string): Promise<MaterialisedSource> {
  const s = (source ?? '').trim();
  if (!s) throw new Error('Source vacío');

  if (looksLikeLocalPath(s)) {
    const abs = path.isAbsolute(s) ? s : path.resolve(s);
    if (!fs.existsSync(abs)) throw new Error(`Ruta local inexistente: ${abs}`);
    return { scanRoot: abs, tempDir: '', isLocal: true };
  }

  const { gitUrl, subPath } = parseRemote(s);
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-skills-'));
  try {
    await runGitClone(gitUrl, tempDir);
  } catch (err) {
    cleanup(tempDir);
    throw err;
  }
  const scanRoot = subPath ? path.join(tempDir, subPath) : tempDir;
  if (!fs.existsSync(scanRoot)) {
    cleanup(tempDir);
    throw new Error(`La subruta del repo no existe: ${subPath}`);
  }
  return { scanRoot, tempDir, isLocal: false };
}

/** Removes a temp dir created by `materialiseSource`. No-op for local sources. */
export function cleanup(tempDir: string): void {
  if (!tempDir) return;
  if (!tempDir.startsWith(os.tmpdir())) return;
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ─── internals ────────────────────────────────────────────────────────

interface RemoteParse { gitUrl: string; subPath?: string }

function parseRemote(source: string): RemoteParse {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return { gitUrl: `https://github.com/${source}.git` };
  }

  const githubTree = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/[^/]+(?:\/(.+))?)?\/?$/.exec(source);
  if (githubTree) {
    const owner = githubTree[1];
    const repo = githubTree[2];
    const sub = githubTree[3];
    const result: RemoteParse = { gitUrl: `https://github.com/${owner}/${repo}.git` };
    if (sub) result.subPath = sub;
    return result;
  }

  const sshMatch = /^git@[^:]+:[^/]+\/[^/]+?(?:\.git)?$/.exec(source);
  if (sshMatch) return { gitUrl: source.endsWith('.git') ? source : `${source}.git` };

  return { gitUrl: source };
}

function runGitClone(url: string, dst: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'git',
      ['clone', '--depth=1', '--single-branch', url, dst],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => { stderr += c.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch { /* dead */ }
    }, CLONE_TIMEOUT_MS);
    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`git clone falló (${code ?? 'timeout'}): ${stderr.trim().slice(0, 400)}`));
    });
  });
}

function sanitiseKey(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
}

function sha1(s: string): string {
  return createHash('sha1').update(s).digest('hex');
}
