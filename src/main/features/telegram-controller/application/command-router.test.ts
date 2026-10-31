import { describe, it, expect, vi } from 'vitest';
import {
  createCommandRouter,
  ConfigActiveProjectStore,
  type ActiveProjectStore,
  type RemoteCommandPorts,
  type RemoteProjectInfo,
  RunForwarder,
  planFileBatches,
} from './command-router';
import { PartialUploadError, TelegramController, type OutboundFile } from './telegram-controller';
import { TelegramApiError } from '../infrastructure/telegram-client';
import { RunGateway, type RunEndEvent } from '../../../shared/run-gateway';
import type { IncomingMessage } from './telegram-controller';
import type { ConfigRepository } from '../../../shared/ports';
import { RunModeStore } from '../../../shared/run-mode-store';
import { DEFAULT_CONFIG, type DeviaConfig } from '../../../../shared/domain/config';

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function makeMsg(text: string, replies: string[]): IncomingMessage {
  return {
    chatId: 1,
    text,
    messageId: 1,
    date: 1,
    reply: async (t: string) => { replies.push(t); },
  };
}

function mutableProject(initial: string | null): ActiveProjectStore {
  let value = initial;
  return { get: () => value, set: (p) => { value = p; } };
}

// Fake workspace tree: keyed by subpath ('' = root). Mirrors the real
// scanner — top-level entries are containers, projects live nested.
const TREE: Record<string, RemoteProjectInfo[]> = {
  '': [
    { path: 'Eviatech', name: 'Eviatech', runnable: false },
    { path: 'standalone', name: 'standalone', runnable: true },
  ],
  Eviatech: [
    { path: 'Eviatech/devia', name: 'devia', runnable: true },
    { path: 'Eviatech/sub', name: 'sub', runnable: false },
  ],
};

function fakePorts(over: Partial<RemoteCommandPorts> = {}): RemoteCommandPorts {
  const runnable = (p: string): boolean => {
    for (const entries of Object.values(TREE)) {
      const hit = entries.find((e) => e.path === p);
      if (hit) return hit.runnable;
    }
    return true;
  };
  return {
    listProjects: (subpath = '') => TREE[subpath] ?? [],
    isRunnable: runnable,
    isRunning: () => false,
    agentLabel: () => 'claude',
    allowShell: () => false,
    ...over,
  };
}

const assistantLine = (text: string): string =>
  JSON.stringify({ type: 'text_delta', delta: text });

describe('createCommandRouter — instructions', () => {
  it('replies with help for /help', async () => {
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: mutableProject('p'), ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/help', replies));
    expect(replies[0]).toContain('control remoto');
  });

  it('warns when no project is active', async () => {
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: mutableProject(null), ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('haz algo', replies));
    expect(replies[0]).toContain('No hay proyecto activo');
  });

  it('submits free text and streams the agent reply back on completion', async () => {
    const gateway = new RunGateway();
    const submitted: Array<{ project: string; text: string }> = [];
    gateway.bindSubmit((project, text) => { submitted.push({ project, text }); return { queued: false }; });

    const router = createCommandRouter({
      gateway,
      activeProject: mutableProject('devia/app'),
      ports: fakePorts(),
      now: () => 0,
      heartbeatMs: 10_000_000,
    });
    const replies: string[] = [];
    await router(makeMsg('arregla el bug', replies));

    expect(submitted).toEqual([{ project: 'devia/app', text: 'arregla el bug' }]);
    expect(replies[0]).toBe('▶️ Ejecutando en *app*…');

    gateway.publish({ type: 'start', project: 'devia/app' });
    gateway.publish({ type: 'output', project: 'devia/app', line: assistantLine('Listo, bug arreglado') });
    gateway.publish({ type: 'end', project: 'devia/app', code: 0 });
    await flush();

    const final = replies.at(-1) ?? '';
    expect(final).toContain('Listo, bug arreglado');
    expect(final).toContain('Completado');
  });

  it('emits a "still working" heartbeat every 2 min while a run is in flight', async () => {
    vi.useFakeTimers();
    try {
      const gateway = new RunGateway();
      gateway.bindSubmit(() => ({ queued: false }));
      // No heartbeatMs override → exercises the real 2-minute default.
      const router = createCommandRouter({
        gateway,
        activeProject: mutableProject('Eviatech/devia'),
        ports: fakePorts(),
      });
      const replies: string[] = [];
      await router(makeMsg('tarea larga', replies));
      gateway.publish({ type: 'start', project: 'Eviatech/devia' });

      const beats = (): number => replies.filter((r) => r.includes('Sigo trabajando')).length;
      expect(beats()).toBe(0);

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(beats()).toBe(1);

      await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
      expect(beats()).toBe(2);

      // `end` stops the heartbeat — no further beats however long we wait.
      gateway.publish({ type: 'end', project: 'Eviatech/devia', code: 0 });
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
      expect(beats()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a queued instruction', async () => {
    const gateway = new RunGateway();
    gateway.bindSubmit(() => ({ queued: true, position: 3 }));
    const router = createCommandRouter({ gateway, activeProject: mutableProject('devia/app'), ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('otra cosa', replies));
    expect(replies[0]).toContain('Encolada (#3)');
  });

  it('surfaces an error footer when the run fails', async () => {
    const gateway = new RunGateway();
    gateway.bindSubmit(() => ({ queued: false }));
    const router = createCommandRouter({ gateway, activeProject: mutableProject('p'), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9 });
    const replies: string[] = [];
    await router(makeMsg('algo', replies));
    gateway.publish({ type: 'end', project: 'p', code: 1, error: 'boom' });
    await flush();
    expect(replies.at(-1)).toContain('Error');
  });
});

describe('createCommandRouter — project commands', () => {
  it('/projects lists the root with copy-paste /use prefixes, icons and marks', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('standalone'),
      ports: fakePorts({ isRunning: (p) => p === 'standalone' }),
    });
    const replies: string[] = [];
    await router(makeMsg('/projects', replies));
    expect(replies[0]).toContain('`/use Eviatech`'); // copy-paste prefix
    expect(replies[0]).toContain('`/use standalone`');
    expect(replies[0]).toContain('📂'); // container icon (Eviatech)
    expect(replies[0]).toContain('📦'); // runnable icon (standalone)
    expect(replies[0]).toContain('➡️'); // active marker on standalone
    expect(replies[0]).toContain('🟢'); // running marker on standalone
  });

  it('/projects browses into the active container folder', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('Eviatech'),
      ports: fakePorts(),
    });
    const replies: string[] = [];
    await router(makeMsg('/projects', replies));
    expect(replies[0]).toContain('Contenido de');
    expect(replies[0]).toContain('`/use Eviatech/devia`'); // nested project
    expect(replies[0]).toContain('`/use Eviatech/sub`');
    expect(replies[0]).toContain('⬆️'); // go-up navigation line
  });

  it('/use resolves a nested path', async () => {
    const active = mutableProject(null);
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: active, ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/use Eviatech/devia', replies));
    expect(active.get()).toBe('Eviatech/devia');
    expect(replies[0]).toContain('Proyecto activo');
  });

  it('/use without an argument returns to the root, clearing the active project', async () => {
    const active = mutableProject('Eviatech/devia');
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: active, ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/use', replies));
    expect(active.get()).toBeNull();
    expect(replies[0]).toContain('raíz');
  });

  it('/use warns when the target is a container folder', async () => {
    const active = mutableProject(null);
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: active, ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/use Eviatech', replies));
    expect(active.get()).toBe('Eviatech');
    expect(replies[0]).toContain('carpeta');
    expect(replies[0]).toContain('/projects');
  });

  it('/use a runnable project notifies the desktop to switch', async () => {
    const switched: string[] = [];
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject(null),
      ports: fakePorts(),
      onActiveProjectChange: (p) => switched.push(p),
    });
    await router(makeMsg('/use Eviatech/devia', []));
    expect(switched).toEqual(['Eviatech/devia']);
  });

  it('/use a container folder does not switch the desktop', async () => {
    const switched: string[] = [];
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject(null),
      ports: fakePorts(),
      onActiveProjectChange: (p) => switched.push(p),
    });
    await router(makeMsg('/use Eviatech', []));
    expect(switched).toEqual([]);
  });

  it('/use rejects an unknown project', async () => {
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: mutableProject(null), ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/use nope', replies));
    expect(replies[0]).toContain('No encuentro');
  });

  it('/status reports project, running state and agent', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({ isRunning: () => true, agentLabel: () => 'claude (opus)' }),
    });
    const replies: string[] = [];
    await router(makeMsg('/status', replies));
    expect(replies[0]).toContain('app');
    expect(replies[0]).toContain('ejecutando');
    expect(replies[0]).toContain('claude (opus)');
  });

  it('/status includes the active project branch and dirty state', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'feat/x', dirty: true, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 2 }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/status', replies));
    expect(replies[0]).toContain('feat/x');
    expect(replies[0]).toContain('con cambios');
    expect(replies[0]).toContain('por defecto: main');
  });

  it('/status shows a clean branch without the default-branch note', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'main', dirty: false, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 0 }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/status', replies));
    expect(replies[0]).toContain('main');
    expect(replies[0]).toContain('limpia');
    expect(replies[0]).not.toContain('por defecto');
  });

  it('/status reports when the active project is not a git repo', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({ gitInfo: () => null }),
    });
    const replies: string[] = [];
    await router(makeMsg('/status', replies));
    expect(replies[0]).toContain('sin repositorio git');
  });

  it('/status shows context % and accumulated cost (S-7)', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        sessionStats: () => ({
          agentId: 'claude', model: 'claude-opus-4-8',
          contextWindow: 1_000_000, contextTokens: 250_000,
          costUsd: 0.7312, turnCount: 3, compactions: [], updatedAt: 1,
        }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/status', replies));
    expect(replies[0]).toContain('25%');
    expect(replies[0]).toContain('250.000 / 1.000.000 tokens');
    expect(replies[0]).toContain('$0.7312');
  });

  it('/status omits the context line but shows cost when no tokens were reported', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        sessionStats: () => ({
          agentId: 'gemini', costUsd: 0, turnCount: 1, compactions: [], updatedAt: 1,
        }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/status', replies));
    expect(replies[0]).not.toContain('Contexto:');
    expect(replies[0]).toContain('$0.0000');
  });

  it('/sync runs the syncer when on a non-default clean branch', async () => {
    const calls: string[] = [];
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'feat/x', dirty: false, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 0 }),
        syncGit: async (p) => { calls.push(p); return { ok: true, branch: 'main', message: 'Sincronizado con main.' }; },
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(calls).toEqual(['devia/app']);
    expect(replies.some((r) => r.includes('Sincronizando'))).toBe(true);
    expect(replies.at(-1)).toContain('Sincronizado con main');
  });

  it('/sync refuses when already on the default branch', async () => {
    const calls: string[] = [];
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'main', dirty: false, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 0 }),
        syncGit: async (p) => { calls.push(p); return { ok: true, message: 'sync' }; },
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(calls).toEqual([]);
    expect(replies[0]).toContain('Ya estás en');
  });

  it('/sync refuses when the working tree is dirty', async () => {
    const calls: string[] = [];
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'feat/x', dirty: true, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 2 }),
        syncGit: async (p) => { calls.push(p); return { ok: true, message: 'sync' }; },
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(calls).toEqual([]);
    expect(replies[0]).toContain('cambios sin confirmar');
  });

  it('/sync refuses when the project is not a git repo', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => null,
        syncGit: async () => ({ ok: true, message: 'sync' }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(replies[0]).toContain('no es un repositorio git');
  });

  it('/sync refuses when the default branch is unknown', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'feat/x', dirty: false, defaultBranch: null, ahead: 0, behind: 0, changedCount: 0 }),
        syncGit: async () => ({ ok: true, message: 'sync' }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(replies[0]).toContain('rama principal');
  });

  it('/sync warns when there is no active project', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject(null),
      ports: fakePorts({ syncGit: async () => ({ ok: true, message: 'sync' }) }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(replies[0]).toContain('Sin proyecto activo');
  });

  it('/sync surfaces the syncer error when it fails', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'feat/x', dirty: false, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 0 }),
        syncGit: async () => ({ ok: false, branch: 'main', message: 'fatal: refusing to merge unrelated histories' }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(replies.at(-1)).toContain('Sync falló');
    expect(replies.at(-1)).toContain('refusing to merge');
  });

  it('/sync reports unavailable when the port is not wired', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({
        gitInfo: () => ({ branch: 'feat/x', dirty: false, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 0 }),
      }),
    });
    const replies: string[] = [];
    await router(makeMsg('/sync', replies));
    expect(replies[0]).toContain('no está disponible');
  });

  it('/stop cancels the active run', async () => {
    const gateway = new RunGateway();
    const stopped: string[] = [];
    gateway.bindStop((p) => { stopped.push(p); return true; });
    const router = createCommandRouter({
      gateway,
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({ isRunning: () => true }),
    });
    const replies: string[] = [];
    await router(makeMsg('/stop', replies));
    expect(stopped).toEqual(['devia/app']);
    expect(replies[0]).toContain('Detenido');
  });

  it('/clean resets the session', async () => {
    const gateway = new RunGateway();
    const reset: string[] = [];
    gateway.bindResetSession((p) => { reset.push(p); return true; });
    const router = createCommandRouter({ gateway, activeProject: mutableProject('devia/app'), ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/clean', replies));
    expect(reset).toEqual(['devia/app']);
    expect(replies[0]).toContain('reiniciada');
  });

  it('rejects unknown commands', async () => {
    const router = createCommandRouter({ gateway: new RunGateway(), activeProject: mutableProject('p'), ports: fakePorts() });
    const replies: string[] = [];
    await router(makeMsg('/wat now', replies));
    expect(replies[0]).toContain('no reconocido');
  });

  it('/exec is blocked when shell is disabled', async () => {
    const runShell = vi.fn();
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({ allowShell: () => false, runShell }),
    });
    const replies: string[] = [];
    await router(makeMsg('/exec ls', replies));
    expect(replies[0]).toContain('desactivados');
    expect(runShell).not.toHaveBeenCalled();
  });

  it('/exec and ! run the command when shell is enabled', async () => {
    const runShell = vi.fn(async () => ({ code: 0, output: 'file1\nfile2', timedOut: false }));
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject('devia/app'),
      ports: fakePorts({ allowShell: () => true, runShell }),
    });
    const replies: string[] = [];
    await router(makeMsg('!ls -la', replies));
    expect(runShell).toHaveBeenCalledWith('devia/app', 'ls -la');
    expect(replies.at(-1)).toContain('file1');
    expect(replies.at(-1)).toContain('código 0');
  });

  it('/mode changes the permission mode used for submissions', async () => {
    const gateway = new RunGateway();
    const modes: Array<string | undefined> = [];
    gateway.bindSubmit((_p, _t, opts) => { modes.push(opts?.mode); return { queued: false }; });
    const router = createCommandRouter({
      gateway, activeProject: mutableProject('devia/app'), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9,
    });
    const replies: string[] = [];
    await router(makeMsg('/mode yolo', replies));
    expect(replies[0]).toContain('yolo');
    await router(makeMsg('haz algo', replies));
    expect(modes).toEqual(['apply-yolo']);
  });

  it('shares the run mode with the desktop store: defaults to plan, /mode and /status use it', async () => {
    const gateway = new RunGateway();
    const modes: Array<string | undefined> = [];
    gateway.bindSubmit((_p, _t, opts) => { modes.push(opts?.mode); return { queued: false }; });
    const runModes = new RunModeStore();
    const router = createCommandRouter({
      gateway, runModes, activeProject: mutableProject('devia/app'), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9,
    });
    const replies: string[] = [];
    await router(makeMsg('arregla el bug', replies));
    expect(modes).toEqual(['plan']);

    runModes.set('devia/app', 'apply', 'desktop'); // changed from the app
    await router(makeMsg('/status', replies));
    expect(replies.at(-1)).toContain('apply');

    await router(makeMsg('/mode yolo', replies));
    expect(runModes.get('devia/app')).toBe('apply-yolo');
  });

  it('a leading plan/execute keyword switches the shared mode (execute only from plan)', async () => {
    const gateway = new RunGateway();
    const modes: Array<string | undefined> = [];
    gateway.bindSubmit((_p, _t, opts) => { modes.push(opts?.mode); return { queued: false }; });
    const runModes = new RunModeStore();
    const router = createCommandRouter({
      gateway, runModes, activeProject: mutableProject('devia/app'), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9,
    });
    const replies: string[] = [];
    await router(makeMsg('ejecuta el plan', replies));
    expect(runModes.get('devia/app')).toBe('apply');
    await router(makeMsg('ejecuta otra cosa', replies));
    expect(runModes.get('devia/app')).toBe('apply');
    await router(makeMsg('analiza esto', replies));
    expect(runModes.get('devia/app')).toBe('plan');
    expect(modes).toEqual(['apply', 'apply', 'plan']);
  });

  it('/agent shows the active agent', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(), activeProject: mutableProject('p'), ports: fakePorts({ agentLabel: () => 'codex' }),
    });
    const replies: string[] = [];
    await router(makeMsg('/agent', replies));
    expect(replies[0]).toContain('codex');
  });
});

describe('createCommandRouter — attachments', () => {
  it('saves the attachment and runs the caption pointing at the file', async () => {
    const gateway = new RunGateway();
    const submitted: Array<{ project: string; text: string }> = [];
    gateway.bindSubmit((project, text) => { submitted.push({ project, text }); return { queued: false }; });
    const saved: Array<{ name: string; mime: string }> = [];
    const router = createCommandRouter({
      gateway,
      activeProject: mutableProject('Eviatech/devia'),
      ports: fakePorts({ saveAttachment: (p) => { saved.push({ name: p.name, mime: p.mime }); return `/saved/${p.name}`; } }),
      now: () => 0,
      heartbeatMs: 1e9,
    });
    const replies: string[] = [];
    await router({
      chatId: 1, text: 'describe la imagen', messageId: 1, date: 1,
      attachments: [{ name: 'a.jpg', mime: 'image/jpeg', kind: 'photo', buffer: new Uint8Array([1]).buffer }],
      reply: async (t: string) => { replies.push(t); },
    });
    expect(saved).toEqual([{ name: 'a.jpg', mime: 'image/jpeg' }]);
    expect(submitted[0]?.project).toBe('Eviatech/devia');
    expect(submitted[0]?.text).toContain('describe la imagen');
    expect(submitted[0]?.text).toContain('/saved/a.jpg');
    expect(submitted[0]?.text).toContain('Read');
  });

  it('warns when there is no active project for an attachment', async () => {
    const router = createCommandRouter({
      gateway: new RunGateway(),
      activeProject: mutableProject(null),
      ports: fakePorts({ saveAttachment: () => '/x' }),
    });
    const replies: string[] = [];
    await router({
      chatId: 1, text: 'x', messageId: 1, date: 1,
      attachments: [{ name: 'a.jpg', mime: 'image/jpeg', kind: 'photo', buffer: new Uint8Array([1]).buffer }],
      reply: async (t: string) => { replies.push(t); },
    });
    expect(replies[0]).toContain('No hay proyecto activo');
  });
});

describe('createCommandRouter — desktop → chat mirror', () => {
  it('mirrors a desktop-initiated run: user prompt + labelled agent reply', async () => {
    const gateway = new RunGateway();
    const pushed: string[] = [];
    createCommandRouter({
      gateway,
      activeProject: mutableProject(null),
      ports: fakePorts(),
      now: () => 0,
      heartbeatMs: 1e9,
      pushChat: async (t) => { pushed.push(t); },
      mirrorDesktop: () => true,
    });

    // A run started from the app carries its text but no Telegram forwarder.
    gateway.publish({ type: 'start', project: 'Eviatech/devia', text: 'arregla el login' });
    expect(pushed[0]).toBe('👤 *[devia]* arregla el login');

    gateway.publish({ type: 'output', project: 'Eviatech/devia', line: assistantLine('Login arreglado') });
    gateway.publish({ type: 'end', project: 'Eviatech/devia', code: 0 });
    await flush();

    const last = pushed.at(-1) ?? '';
    expect(last).toContain('*[devia]*'); // project label always on the agent reply
    expect(last).toContain('Login arreglado');
    expect(last).toContain('Completado');
  });

  it('does not mirror when mirrorDesktop is off', async () => {
    const gateway = new RunGateway();
    const pushed: string[] = [];
    createCommandRouter({
      gateway, activeProject: mutableProject(null), ports: fakePorts(),
      pushChat: async (t) => { pushed.push(t); }, mirrorDesktop: () => false,
    });
    gateway.publish({ type: 'start', project: 'Eviatech/devia', text: 'algo' });
    gateway.publish({ type: 'end', project: 'Eviatech/devia', code: 0 });
    await flush();
    expect(pushed).toEqual([]);
  });

  it('does not double-mirror a Telegram-initiated run (no 👤 prompt push)', async () => {
    const gateway = new RunGateway();
    gateway.bindSubmit(() => ({ queued: false }));
    const replies: string[] = [];
    const pushed: string[] = [];
    const router = createCommandRouter({
      gateway, activeProject: mutableProject('Eviatech/devia'), ports: fakePorts(),
      now: () => 0, heartbeatMs: 1e9,
      pushChat: async (t) => { pushed.push(t); }, mirrorDesktop: () => true,
    });
    await router(makeMsg('haz algo', replies)); // registers a forwarder for the project
    gateway.publish({ type: 'start', project: 'Eviatech/devia', text: 'haz algo' });
    gateway.publish({ type: 'end', project: 'Eviatech/devia', code: 0 });
    await flush();

    expect(pushed.some((p) => p.startsWith('👤'))).toBe(false);
    expect(replies.at(-1)).toContain('*[devia]*'); // reply still labelled
  });
});

describe('createCommandRouter — files (S-32)', () => {
  const P = 'Eviatech/devia';

  function file(name: string, kind: OutboundFile['kind'], over: Partial<OutboundFile> = {}): OutboundFile {
    return { path: `/w/${name}`, name, size: 1000, mime: 'application/octet-stream', kind, source: 'tool', ...over };
  }

  type Sent = { op: 'text' | 'file' | 'files'; value: string };

  /** A chat message whose text and file uploads all land in one ordered log. */
  function fileMsg(text: string, log: Sent[], opts: {
    fail?: (names: string[]) => unknown;
    gate?: Promise<void>;
  } = {}): IncomingMessage {
    const upload = async (op: 'file' | 'files', files: readonly OutboundFile[]): Promise<void> => {
      await opts.gate;
      const names = files.map((f) => f.name);
      const err = opts.fail?.(names);
      if (err) throw err;
      log.push({ op, value: names.join(',') });
    };
    return {
      chatId: 1, text, messageId: 1, date: 1,
      reply: async (t) => { log.push({ op: 'text', value: t }); },
      replyFile: (f) => upload('file', [f]),
      replyFiles: (fs) => upload('files', fs),
    };
  }

  function setup(): { gateway: RunGateway; router: ReturnType<typeof createCommandRouter>; outcomes: string[] } {
    const gateway = new RunGateway();
    gateway.bindSubmit(() => ({ queued: false }));
    const outcomes: string[] = [];
    const router = createCommandRouter({
      gateway, activeProject: mutableProject(P), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9,
      onFileOutcome: (ctx, f, outcome) => outcomes.push(`${ctx.agentId ?? '-'}:${f.name}:${outcome}`),
    });
    return { gateway, router, outcomes };
  }

  const run = (gateway: RunGateway, files: OutboundFile[], end: { code: number | null; error?: string } = { code: 0 }): void => {
    gateway.publish({ type: 'start', project: P, agentId: 'claude' });
    gateway.publish({ type: 'output', project: P, line: assistantLine('Hecho') });
    for (const f of files) gateway.publish({ type: 'file', project: P, file: f });
    gateway.publish({ type: 'end', project: P, ...end });
  };

  it('sends the final text first, then the files, announcing them', async () => {
    const { gateway, router, outcomes } = setup();
    const log: Sent[] = [];
    await router(fileMsg('genera el informe', log));
    run(gateway, [file('informe.pdf', 'document')]);
    await flush();

    const ops = log.slice(1); // skip the "▶️ Ejecutando" ack
    expect(ops.map((o) => o.op)).toEqual(['text', 'file']);
    expect(ops[0]?.value).toContain('Hecho');
    expect(ops[0]?.value).toContain('📎 1 archivo(s) a continuación');
    expect(ops[1]?.value).toBe('informe.pdf');
    expect(outcomes).toEqual(['claude:informe.pdf:delivered']);
  });

  it('a run without files produces exactly the pre-S-32 reply', async () => {
    const { gateway, router } = setup();
    const log: Sent[] = [];
    await router(fileMsg('hola', log));
    run(gateway, []);
    await flush();
    expect(log.slice(1)).toEqual([{ op: 'text', value: '*[devia]*\nHecho\n\n✅ *Completado* (código 0)' }]);
  });

  it('groups 3 photos into one album and dedupes by path', async () => {
    const { gateway, router } = setup();
    const log: Sent[] = [];
    await router(fileMsg('fotos', log));
    const a = file('a.png', 'photo');
    run(gateway, [a, file('b.png', 'photo'), a, file('c.png', 'photo')]);
    await flush();
    expect(log.slice(2)).toEqual([{ op: 'files', value: 'a.png,b.png,c.png' }]);
    expect(log[1]?.value).toContain('📎 3 archivo(s)');
  });

  it('a photo and a pdf go as two separate uploads (albums are homogeneous)', async () => {
    const { gateway, router } = setup();
    const log: Sent[] = [];
    await router(fileMsg('x', log));
    run(gateway, [file('doc.pdf', 'document'), file('foto.png', 'photo')]);
    await flush();
    expect(log.slice(2)).toEqual([
      { op: 'file', value: 'foto.png' },
      { op: 'file', value: 'doc.pdf' },
    ]);
  });

  it('plans photo/video albums first, then documents, then audio, at most 10 per album', () => {
    const photos = Array.from({ length: 11 }, (_, i) => file(`p${i}.png`, 'photo'));
    const batches = planFileBatches([file('a.mp3', 'audio'), file('d.pdf', 'document'), ...photos, file('v.mp4', 'video')]);
    expect(batches.map((b) => b.map((f) => f.name).join(','))).toEqual([
      [...photos.slice(0, 10).map((f) => f.name)].join(','),
      'p10.png,v.mp4',
      'd.pdf',
      'a.mp3',
    ]);
  });

  it('reports per-file outcomes when only part of an album failed', async () => {
    const { gateway, router, outcomes } = setup();
    const log: Sent[] = [];
    const msg = fileMsg('x', log);
    msg.replyFiles = async (fs) => {
      const failed = fs.find((f) => f.name === 'b.png');
      if (failed) throw new PartialUploadError(new Map([[failed.path, new TelegramApiError('bad', { statusCode: 400 })]]));
    };
    await router(msg);
    run(gateway, [file('a.png', 'photo'), file('b.png', 'photo'), file('c.png', 'photo')]);
    await flush();
    expect(outcomes).toEqual([
      'claude:a.png:delivered',
      'claude:b.png:failed:http-400',
      'claude:c.png:delivered',
    ]);
    expect(log.at(-1)).toEqual({ op: 'text', value: '⚠️ No pude enviar: b.png (http-400)' });
  });

  it('reports a failed upload and keeps sending the rest', async () => {
    const { gateway, router, outcomes } = setup();
    const log: Sent[] = [];
    const fail = (names: string[]): unknown =>
      names.includes('informe.pdf') ? new TelegramApiError('too big', { statusCode: 413 })
        : names.includes('gone.mp3') ? Object.assign(new Error('x'), { code: 'ENOENT' })
          : undefined;
    await router(fileMsg('x', log, { fail }));
    run(gateway, [file('informe.pdf', 'document'), file('foto.png', 'photo'), file('gone.mp3', 'audio')]);
    await flush();

    expect(log.slice(2)).toEqual([
      { op: 'file', value: 'foto.png' },
      { op: 'text', value: '⚠️ No pude enviar: informe.pdf (http-413), gone.mp3 (not-found)' },
    ]);
    expect(outcomes).toEqual([
      'claude:foto.png:delivered',
      'claude:informe.pdf:failed:http-413',
      'claude:gone.mp3:failed:not-found',
    ]);
  });

  it('reports files the main process refused alongside upload failures', async () => {
    const { gateway, router } = setup();
    const log: Sent[] = [];
    await router(fileMsg('x', log));
    gateway.publish({ type: 'start', project: P });
    gateway.publish({ type: 'file_rejected', project: P, name: '.env', reason: 'secret', source: 'outbox' });
    gateway.publish({ type: 'end', project: P, code: 0 });
    await flush();
    expect(log[1]?.value).not.toContain('📎');
    expect(log.at(-1)).toEqual({ op: 'text', value: '⚠️ No pude enviar: .env (secret)' });
  });

  it('does not upload the files of a stopped run: one line, audited failed:stopped', async () => {
    const { gateway, router, outcomes } = setup();
    const log: Sent[] = [];
    await router(fileMsg('x', log));
    run(gateway, [file('r.pdf', 'document'), file('s.pdf', 'document')], { code: null, error: 'stopped' });
    await flush();
    expect(log[1]?.value).toContain('Detenido');
    expect(log[1]?.value).not.toContain('📎');
    expect(log.slice(2)).toEqual([{ op: 'text', value: '⏹️ Ejecución detenida: no envié 2 archivo(s)' }]);
    expect(outcomes).toEqual(['claude:r.pdf:failed:stopped', 'claude:s.pdf:failed:stopped']);
  });

  it('treats an end with cancelReason "user" (the runner\'s stop) as stopped', async () => {
    const { gateway, router, outcomes } = setup();
    const log: Sent[] = [];
    await router(fileMsg('x', log));
    gateway.publish({ type: 'start', project: P, agentId: 'claude' });
    gateway.publish({ type: 'file', project: P, file: file('r.pdf', 'document') });
    gateway.publish({ type: 'end', project: P, code: 1, error: 'Cancelado por ti.', cancelReason: 'user' } as RunEndEvent);
    await flush();
    expect(log[1]?.value).toContain('⏹️ *Detenido*');
    expect(log.some((o) => o.op === 'file')).toBe(false);
    expect(outcomes).toEqual(['claude:r.pdf:failed:stopped']);
  });

  it('still sends the files of a run that ended in error', async () => {
    const { gateway, router, outcomes } = setup();
    const log: Sent[] = [];
    await router(fileMsg('x', log));
    run(gateway, [file('r.pdf', 'document')], { code: 1, error: 'boom' });
    await flush();
    expect(log[1]?.value).toContain('❌ *Error* (boom)');
    expect(log[2]).toEqual({ op: 'file', value: 'r.pdf' });
    expect(outcomes).toEqual(['claude:r.pdf:delivered']);
  });

  it('the desktop mirror uploads through pushChatFile(s)', async () => {
    const gateway = new RunGateway();
    const pushed: string[] = [];
    createCommandRouter({
      gateway, activeProject: mutableProject(null), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9,
      pushChat: async (t) => { pushed.push(t); },
      pushChatFile: async (f) => { pushed.push(`file:${f.name}`); },
      pushChatFiles: async (fs) => { pushed.push(`files:${fs.map((f) => f.name).join(',')}`); },
      mirrorDesktop: () => true,
    });
    gateway.publish({ type: 'start', project: P, text: 'informe' });
    gateway.publish({ type: 'file', project: P, file: file('a.pdf', 'document') });
    gateway.publish({ type: 'file', project: P, file: file('b.pdf', 'document') });
    gateway.publish({ type: 'end', project: P, code: 0 });
    await flush();
    expect(pushed.at(-1)).toBe('files:a.pdf,b.pdf');
    expect(pushed.at(-2)).toContain('📎 2 archivo(s)');
  });

  it('the desktop mirror audits failed:not-connected when the bot is disconnected', async () => {
    const gateway = new RunGateway();
    const controller = new TelegramController({
      config: { get: () => ({ ...DEFAULT_CONFIG }), set: () => undefined } as unknown as ConfigRepository,
      emitStatus: () => undefined,
    });
    const outcomes: string[] = [];
    createCommandRouter({
      gateway, activeProject: mutableProject(null), ports: fakePorts(), now: () => 0, heartbeatMs: 1e9,
      pushChat: (t) => controller.push(t),
      pushChatFile: (f) => controller.pushFile(f),
      pushChatFiles: (fs) => controller.pushFiles(fs),
      onFileOutcome: (_ctx, f, outcome) => outcomes.push(`${f.name}:${outcome}`),
      mirrorDesktop: () => true,
    });
    gateway.publish({ type: 'start', project: P, text: 'informe' });
    gateway.publish({ type: 'file', project: P, file: file('a.pdf', 'document') });
    gateway.publish({ type: 'file', project: P, file: file('b.png', 'photo') });
    gateway.publish({ type: 'end', project: P, code: 0 });
    await flush();
    expect(outcomes).toEqual(['b.png:failed:not-connected', 'a.pdf:failed:not-connected']);
  });

  it('disposes the forwarder only after the uploads finish', async () => {
    const dispose = vi.spyOn(RunForwarder.prototype, 'dispose');
    try {
      const { gateway, router } = setup();
      const log: Sent[] = [];
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      await router(fileMsg('x', log, { gate }));
      run(gateway, [file('r.pdf', 'document')]);
      await flush();
      expect(dispose).not.toHaveBeenCalled();
      expect(log.some((o) => o.op === 'file')).toBe(false);

      release();
      await flush();
      expect(log.at(-1)).toEqual({ op: 'file', value: 'r.pdf' });
      expect(dispose).toHaveBeenCalledTimes(1);
    } finally {
      dispose.mockRestore();
    }
  });

  it('a second run that ends while the first is uploading replies after its files', async () => {
    const { gateway, router } = setup();
    const log: Sent[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    await router(fileMsg('uno', log, { gate }));
    run(gateway, [file('r.pdf', 'document')]);
    await flush();

    await router(fileMsg('dos', log));
    gateway.publish({ type: 'start', project: P });
    gateway.publish({ type: 'output', project: P, line: assistantLine('Segunda') });
    gateway.publish({ type: 'end', project: P, code: 0 });
    await flush();
    expect(log.some((o) => o.value.includes('Segunda'))).toBe(false);

    release();
    await flush();
    await flush();
    const fileIdx = log.findIndex((o) => o.op === 'file');
    const secondIdx = log.findIndex((o) => o.value.includes('Segunda'));
    expect(fileIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(fileIdx);
  });

  it('ignores file events when the chat cannot receive files (no 📎 line)', async () => {
    const { gateway, router } = setup();
    const replies: string[] = [];
    await router(makeMsg('x', replies));
    run(gateway, [file('r.pdf', 'document')]);
    await flush();
    expect(replies.at(-1)).not.toContain('📎');
  });
});

describe('ConfigActiveProjectStore', () => {
  function cfgRepo(lastProjectPath?: string): ConfigRepository {
    const cfg: DeviaConfig = { ...DEFAULT_CONFIG, ...(lastProjectPath !== undefined && { lastProjectPath }) };
    return {
      get: () => cfg,
      set: (p: Partial<DeviaConfig>) => Object.assign(cfg, p),
      reload: () => cfg,
      hasWorkspace: () => true,
      configPath: () => '/tmp/c.json',
      deviaDir: () => '/tmp/.devia-app',
    } as ConfigRepository;
  }

  it('/use persists lastProjectPath (so the app picks up the same project)', () => {
    const repo = cfgRepo('devia/app');
    const store = new ConfigActiveProjectStore(repo);
    expect(store.get()).toBe('devia/app');
    store.set('other/proj');
    expect(repo.get().lastProjectPath).toBe('other/proj');
    expect(store.get()).toBe('other/proj');
  });

  it('reflects a project selected in the app (lastProjectPath changed externally)', () => {
    const repo = cfgRepo('devia/app');
    const store = new ConfigActiveProjectStore(repo);
    repo.set({ lastProjectPath: 'picked/in/app' });
    expect(store.get()).toBe('picked/in/app');
  });

  it('returns null when no project is known', () => {
    expect(new ConfigActiveProjectStore(cfgRepo()).get()).toBeNull();
  });
});
