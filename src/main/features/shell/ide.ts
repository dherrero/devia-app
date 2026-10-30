import { spawn, execFile, type SpawnOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  IDE_CATALOG,
  availableIdes,
  buildIdeSpawn,
  ideCandidates,
  type IdeId,
  type IdeInfo,
  type IdeSpec,
  type OsKind,
} from '../../../shared/domain/ide';

function osKind(): OsKind {
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

function macAppExists(appName: string): boolean {
  return [
    `/Applications/${appName}.app`,
    `/System/Applications/${appName}.app`,
    join(homedir(), 'Applications', `${appName}.app`),
  ].some((location) => existsSync(location));
}

/** Resolve a command on PATH via `where` (Windows) or `which` (Unix). */
function onPath(probe: 'where' | 'which', cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(probe, [cmd], (err, stdout) => resolve(!err && stdout.trim().length > 0));
  });
}

async function resolveLaunch(spec: IdeSpec, os: OsKind): Promise<string | null> {
  const candidates = ideCandidates(spec, os);
  if (os === 'mac') {
    for (const app of candidates) if (macAppExists(app)) return app;
    return null;
  }
  const probe = os === 'win' ? 'where' : 'which';
  for (const cmd of candidates) if (await onPath(probe, cmd)) return cmd;
  return null;
}

// Detection runs PATH/filesystem probes for every catalog entry, so the result
// is memoised for the process lifetime. A freshly installed IDE shows up after
// the next app launch — an acceptable trade-off versus probing on every menu
// open.
let cache: Map<IdeId, string> | null = null;

async function ensureDetected(force = false): Promise<Map<IdeId, string>> {
  if (cache && !force) return cache;
  const os = osKind();
  const entries = await Promise.all(
    IDE_CATALOG.map(async (spec) => [spec.id, await resolveLaunch(spec, os)] as const),
  );
  const next = new Map<IdeId, string>();
  for (const [id, launch] of entries) if (launch) next.set(id, launch);
  cache = next;
  return next;
}

/** Installed IDEs in catalog order, ready for the renderer selector. */
export async function listIdes(): Promise<IdeInfo[]> {
  const resolved = await ensureDetected();
  const record: Partial<Record<IdeId, string>> = {};
  for (const [id, launch] of resolved) record[id] = launch;
  return availableIdes(record);
}

/** Test seam — drop the memoised detection result. */
export function resetIdeCache(): void {
  cache = null;
}

/**
 * Open `projectPath` in the requested IDE. Falls back to the first installed
 * IDE (VS Code preferred) when `ideId` is omitted or not available, so a stale
 * renderer preference still does something sensible.
 */
export async function openInIde(projectPath: string, ideId?: IdeId): Promise<true> {
  const resolved = await ensureDetected();
  const id: IdeId | undefined =
    ideId && resolved.has(ideId)
      ? ideId
      : resolved.has('vscode')
        ? 'vscode'
        : resolved.keys().next().value;
  const launch = id ? resolved.get(id) : undefined;
  if (!launch) throw new Error('No IDE available to open the project');

  const { cmd, args, useShell, waitForExit } = buildIdeSpawn(launch, projectPath, osKind());
  const opts: SpawnOptions = {
    env: { ...process.env, VSCODE_CWD: projectPath },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: useShell,
  };

  return new Promise<true>((resolve, reject) => {
    const child = spawn(cmd, args, opts);
    let stderr = '';
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', (err: Error) => reject(err));
    if (waitForExit) {
      child.on('exit', (code: number | null) => {
        if (code === 0) resolve(true);
        else reject(new Error(stderr.trim() || `open exited with code ${code ?? 'unknown'}`));
      });
    } else {
      child.unref();
      setImmediate(() => resolve(true));
    }
  });
}
