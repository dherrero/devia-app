import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';
import { IPC } from '../../../shared/contracts/ipc-channels';
import type { CloneRequest } from '../../../shared/domain/clone';
import { resolveInsideWorkspace } from '../../shared/workspace-paths';
import { ensureAgentDefaults } from '../../shared/agent-defaults';
import { spawnOnPath } from '../cli-adapters/infrastructure/path-command';

const NAME_RE = /^[a-zA-Z0-9._-]+$/;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

export interface CloneDeps {
  config: ConfigRepository;
}

export function buildCloneFeature(deps: CloneDeps): Feature {
  return {
    id: 'clone',
    register(ctx: FeatureContext) {
      ctx.ipc.on(IPC.cloneRun, (_e, payload: CloneRequest | undefined) => {
        const req: CloneRequest = payload ?? { repositoryUrl: '', projectName: '' };
        ctx.send('clone:start', { repositoryUrl: req.repositoryUrl ?? '' });
        runClone(deps.config, req,
          (line) => ctx.send('clone:output', { line }),
          (result) => ctx.send('clone:end', { code: 0, fullPath: result.fullPath }),
          (msg) => ctx.send('clone:end', { code: 1, error: msg }),
        );
      });
    },
  };
}

function emitLines(buf: string, onOutput: (line: string) => void): string {
  const lines = buf.split(/\r?\n/);
  const tail = lines.pop() ?? '';
  for (const line of lines) onOutput(line);
  return tail;
}

function streamProc(
  proc: ChildProcess,
  onOutput: (line: string) => void,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let outTail = '';
    let errTail = '';
    const timer = setTimeout(() => proc.kill('SIGTERM'), timeoutMs);
    proc.stdout?.on('data', (c: Buffer) => { outTail = emitLines(outTail + c.toString(), onOutput); });
    proc.stderr?.on('data', (c: Buffer) => { errTail = emitLines(errTail + c.toString(), onOutput); });
    proc.on('error', (err: Error) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (outTail) onOutput(outTail);
      if (errTail) onOutput(errTail);
      if (code === 0) resolve();
      else reject(new Error(`git clone terminó con código ${code ?? 'desconocido'}`));
    });
  });
}

async function runClone(
  config: ConfigRepository,
  payload: CloneRequest,
  onOutput: (line: string) => void,
  onDone: (result: { fullPath: string }) => void,
  onError: (msg: string) => void,
): Promise<void> {
  try {
    const url = (payload.repositoryUrl ?? '').trim();
    if (!url) throw new Error('La URL del repositorio es obligatoria');

    const name = (payload.projectName ?? '').trim();
    if (!name || !NAME_RE.test(name)) {
      throw new Error('Nombre de proyecto inválido (solo letras, números, ., _ y -)');
    }

    const parentPath = payload.parentPath ?? '';
    // Validate parentPath stays inside the workspace before composing.
    resolveInsideWorkspace(config, parentPath);
    const fullPath = parentPath ? `${parentPath}/${name}` : name;
    const { abs: dst } = resolveInsideWorkspace(config, fullPath);
    if (fs.existsSync(dst)) throw new Error(`Ya existe una carpeta en ${fullPath}`);

    onOutput(`$ git clone ${url} ${dst}`);
    const proc = spawnOnPath('git', ['clone', url, dst], { stdio: ['ignore', 'pipe', 'pipe'] });
    await streamProc(proc, onOutput, CLONE_TIMEOUT_MS);

    // No-op per agent when the cloned repo already ships its own config.
    ensureAgentDefaults(dst);

    onDone({ fullPath });
  } catch (err: unknown) {
    onError(err instanceof Error ? err.message : String(err));
  }
}
