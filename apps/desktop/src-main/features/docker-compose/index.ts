import { spawn, execFile, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { ComposeAction } from '../../../shared/domain/compose';

/** Probe `docker compose version` to decide whether the Docker UI surfaces.
 *  Resolves false on any error (binary missing, daemon down, timeout). */
function detectDocker(): Promise<{ available: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      ['compose', 'version'],
      { timeout: 4000, windowsHide: true },
      (err) => resolve({ available: !err }),
    );
    child.on('error', () => resolve({ available: false }));
  });
}

const COMPOSE_NAMES = ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml'];
const SEARCH_SKIP = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', '.venv', 'venv', 'target', '.cache',
]);
const SEARCH_MAX_DEPTH = 4;
const SEARCH_MAX_HITS = 50;

/** A compose file at the project ROOT, as a relative name, or null. */
function detectComposeAtRoot(projectDir: string): string | null {
  for (const name of COMPOSE_NAMES) {
    try {
      if (fs.statSync(path.join(projectDir, name)).isFile()) return name;
    } catch { /* not present */ }
  }
  return null;
}

/** Bounded recursive scan for compose files (some apps keep them in a
 *  subfolder). Returns project-relative paths, shallowest first. */
function searchCompose(projectDir: string): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number, rel: string): void => {
    if (depth > SEARCH_MAX_DEPTH || found.length >= SEARCH_MAX_HITS) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isFile() && COMPOSE_NAMES.includes(e.name)) {
        found.push(rel ? `${rel}/${e.name}` : e.name);
      }
    }
    for (const e of entries) {
      if (e.isDirectory() && !SEARCH_SKIP.has(e.name) && !e.name.startsWith('.')) {
        walk(path.join(dir, e.name), depth + 1, rel ? `${rel}/${e.name}` : e.name);
      }
    }
  };
  walk(projectDir, 0, '');
  return found.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}

/** Guard a renderer-supplied compose path: project-relative, no escape. */
function safeComposeFile(file: unknown): string | null {
  if (typeof file !== 'string' || !file) return null;
  if (path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) return null;
  return file;
}

const TIMEOUTS: Record<ComposeAction, number> = {
  deploy: 15 * 60 * 1000,
  down:   30 * 1000,
  logs:   15 * 1000,
};

const ARGS: Record<ComposeAction, readonly string[]> = {
  deploy: ['up', '-d', '--build'],
  down:   ['down'],
  logs:   ['logs', '--tail', '50', '--no-color'],
};

export interface ComposeDeps {
  config: ConfigRepository;
}

export function buildComposeFeature(deps: ComposeDeps): Feature {
  const running = new Map<string, ChildProcess>();

  return {
    id: 'docker-compose',
    register(ctx: FeatureContext) {
      // Detection probe — the renderer calls this at startup (splash) to
      // decide whether the Docker rail panel is shown for this session.
      ctx.ipc.handle(IPC.dockerDetect, () => detectDocker());

      const projectDir = (project: string): string | null => {
        const { workspaceRoot } = deps.config.get();
        return workspaceRoot ? path.join(workspaceRoot, project) : null;
      };

      // Per-project: is there a compose file at the root? Gates the panel's
      // run actions so we never run `docker compose` where it would just error.
      ctx.ipc.handle(IPC.composeDetect, (_e, project: string): { file: string | null } => {
        const dir = projectDir(project);
        return { file: dir ? detectComposeAtRoot(dir) : null };
      });

      // On-demand deep scan for compose files in subfolders.
      ctx.ipc.handle(IPC.composeSearch, (_e, project: string): { files: string[] } => {
        const dir = projectDir(project);
        return { files: dir ? searchCompose(dir) : [] };
      });

      ctx.ipc.on(IPC.composeRun, (_e, project: string, action: ComposeAction, composeFile?: string) => {
        ctx.send('compose:start', { project, action });

        if (!ARGS[action]) {
          ctx.send('compose:end', { project, action, code: null, error: `Acción desconocida: ${action}` });
          return;
        }
        if (running.has(project)) {
          ctx.send('compose:end', { project, action, code: null, error: 'busy' });
          return;
        }

        const { workspaceRoot } = deps.config.get();
        if (!workspaceRoot) {
          ctx.send('compose:end', { project, action, code: null, error: 'Workspace no configurado' });
          return;
        }
        const cwd = path.join(workspaceRoot, project);
        // A nested compose file (found via search) is passed with `-f` and
        // run from the project root; null/invalid → docker resolves the root file.
        const file = safeComposeFile(composeFile);
        const fileArgs = file ? ['-f', file] : [];

        let proc: ChildProcess;
        try {
          proc = spawn('docker', ['compose', ...fileArgs, ...ARGS[action]], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.send('compose:end', { project, action, code: null, error: message });
          return;
        }

        running.set(project, proc);
        const timer = setTimeout(() => proc.kill('SIGTERM'), TIMEOUTS[action]);

        const forward = (data: Buffer): void =>
          ctx.send('compose:output', { project, action, chunk: data.toString() });
        proc.stdout?.on('data', forward);
        proc.stderr?.on('data', forward);

        proc.on('close', (code) => {
          clearTimeout(timer);
          running.delete(project);
          ctx.send('compose:end', { project, action, code });
        });
        proc.on('error', (err) => {
          clearTimeout(timer);
          running.delete(project);
          ctx.send('compose:end', { project, action, code: null, error: err.message });
        });
      });
    },
    onBeforeQuit() {
      for (const proc of running.values()) {
        try { proc.kill('SIGTERM'); } catch { /* swallow */ }
      }
      running.clear();
    },
  };
}
