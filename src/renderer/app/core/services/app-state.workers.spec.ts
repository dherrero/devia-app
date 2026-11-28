/**
 * S-56 T11 — a cross-agent worker run reaches the renderer like any run, keyed
 * by its worker run key. The renderer folds it into its CONTROLLER's thread:
 * no ghost session, no false "running", the bubble held until the controller's
 * own turn ends so the thread keeps its order.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { DeviaConfigView } from '../../../types/devia';
import type { WorkerChangedEvent } from '../../../../shared/contracts/events';
import type { WorkerRun } from '../../../../shared/domain/cross-agent';
import { workerRunKey } from '../../../../shared/domain/cross-agent';
import type { RunId } from '../../../../shared/domain/agent';

const noop = (): void => undefined;
const RUN = 'run-w1' as RunId;
const PARENT_RUN = 'run-p1' as RunId;
const KEY = workerRunKey('proj-a', 'T-1', 1);

function makeConfig(): DeviaConfigView {
  return {
    workspaceRoot: '/ws',
    ignoreFolders: [],
    agentId: 'claude',
    agentModels: {},
    agentCliEnv: {},
    agentToolPolicy: {},
    memory: { enabled: true, blockExternalMemory: true, engramImported: false },
    remoteControl: { allowShell: false, mirrorDesktop: false, allowFileSend: true, telegram: { enabled: false, botToken: '', chatId: '' } },
    configPath: '/cfg',
    hasWorkspace: true,
  } as unknown as DeviaConfigView;
}

const worker = (over: Partial<WorkerRun> = {}): WorkerRun => ({
  id: 'W-1',
  parentKey: 'proj-a',
  turnId: 'turn-1',
  taskId: 'T-1',
  role: 'implementer',
  agentId: 'pi',
  runKey: KEY,
  state: 'running',
  ...over,
});

describe('AppStateService — cross-agent workers (S-56 T11)', () => {
  let service: AppStateService;
  let onStart: (e: { project: string; runId?: RunId; agentId?: string }) => void;
  let onOutput: (e: { project: string; runId?: RunId; line: string }) => void;
  let onEnd: (e: { project: string; runId?: RunId; code: number | null; error?: string }) => void;
  let onWorker: (e: WorkerChangedEvent) => void;
  const toast = { show: vi.fn() };

  const text = (delta: string): string => JSON.stringify({ type: 'text_delta', delta });
  const messages = (key: string) => service.chats().get(key) ?? [];

  beforeEach(() => {
    toast.show.mockClear();
    const api: Record<string, unknown> = new Proxy(
      {
        platform: 'linux',
        isWSL: false,
        getRunModes: () => Promise.resolve([]),
        onProcessStart: (cb: typeof onStart) => { onStart = cb; },
        onClaudeOutput: (cb: typeof onOutput) => { onOutput = cb; },
        onProcessEnd: (cb: typeof onEnd) => { onEnd = cb; },
        onWorkerChanged: (cb: typeof onWorker) => { onWorker = cb; },
      } as Record<string, unknown>,
      { get: (t, k: string) => (k in t ? t[k] : noop) },
    );
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: toast },
      ],
    });
    service = TestBed.inject(AppStateService);
    service['config'].set(makeConfig());
    service['wireBridgeEvents']();
  });

  it('shows a live worker bubble under its controller, tagged with the worker info', () => {
    onWorker({ parentKey: 'proj-a', worker: worker() });
    onStart({ project: KEY, runId: RUN, agentId: 'pi' });
    const live = service.workerMessagesFor('proj-a');
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ streaming: true, worker: { id: 'W-1', role: 'implementer', agentId: 'pi', taskId: 'T-1' } });
    expect(service.workerMessagesFor('proj-b')).toEqual([]);
  });

  it('never marks the worker key as a running project and never creates a chat for it', () => {
    onStart({ project: KEY, runId: RUN, agentId: 'pi' });
    expect(service.runningPaths().has(KEY)).toBe(false);
    onEnd({ project: KEY, runId: RUN, code: 0 });
    expect(service.chats().has(KEY)).toBe(false);
    expect(service.assistantStreams().has(KEY)).toBe(false);
  });

  it('adds the finished worker message straight to the thread when the controller is not streaming', () => {
    onWorker({ parentKey: 'proj-a', worker: worker() });
    onStart({ project: KEY, runId: RUN, agentId: 'pi' });
    onOutput({ project: KEY, runId: RUN, line: text('Implemented T-1.') });
    onEnd({ project: KEY, runId: RUN, code: 0 });

    const thread = messages('proj-a');
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ role: 'assistant', streaming: false, worker: { id: 'W-1' } });
    expect(thread[0]?.text).toContain('Implemented T-1.');
    expect(service.workerMessagesFor('proj-a')).toEqual([]);
  });

  it('holds it while the controller streams, and keeps the order controller → worker when that turn ends', () => {
    onStart({ project: 'proj-a', runId: PARENT_RUN, agentId: 'claude' });
    onWorker({ parentKey: 'proj-a', worker: worker() });
    onStart({ project: KEY, runId: RUN, agentId: 'pi' });
    onOutput({ project: KEY, runId: RUN, line: text('done') });
    onEnd({ project: KEY, runId: RUN, code: 0 });

    // Still shown (held), but not in the thread yet.
    expect(messages('proj-a')).toHaveLength(0);
    expect(service.workerMessagesFor('proj-a')).toHaveLength(1);

    onOutput({ project: 'proj-a', runId: PARENT_RUN, line: text('All good.') });
    onEnd({ project: 'proj-a', runId: PARENT_RUN, code: 0 });

    const thread = messages('proj-a');
    expect(thread.map((m) => (m.worker ? 'worker' : 'controller'))).toEqual(['controller', 'worker']);
    expect(service.workerMessagesFor('proj-a')).toEqual([]);
  });

  it('patches the final state into the saved message when worker:changed arrives later', () => {
    onWorker({ parentKey: 'proj-a', worker: worker() });
    onStart({ project: KEY, runId: RUN, agentId: 'pi' });
    onEnd({ project: KEY, runId: RUN, code: 0 });
    expect(messages('proj-a')[0]?.worker?.state).toBe('running');

    onWorker({ parentKey: 'proj-a', worker: worker({ state: 'done', status: 'DONE', endedAt: 5 }) });
    expect(messages('proj-a')[0]?.worker).toMatchObject({ state: 'done', status: 'DONE' });
  });

  it('patches a message that is still held', () => {
    onStart({ project: 'proj-a', runId: PARENT_RUN });
    onWorker({ parentKey: 'proj-a', worker: worker() });
    onStart({ project: KEY, runId: RUN });
    onEnd({ project: KEY, runId: RUN, code: 0 });
    onWorker({ parentKey: 'proj-a', worker: worker({ state: 'done', status: 'DONE' }) });
    expect(service.workerMessagesFor('proj-a')[0]?.worker?.state).toBe('done');
  });

  it('a failing worker leaves no error toast or system message in the thread', () => {
    onStart({ project: KEY, runId: RUN });
    onEnd({ project: KEY, runId: RUN, code: 1, error: 'boom' });
    expect(toast.show).not.toHaveBeenCalled();
    expect(messages('proj-a').filter((m) => m.role === 'system')).toEqual([]);
    expect(messages('proj-a')).toHaveLength(1);
  });

  it('a fix round under the same run key adds a second bubble', () => {
    for (const id of ['W-1', 'W-2']) {
      onWorker({ parentKey: 'proj-a', worker: worker({ id }) });
      onStart({ project: KEY, runId: RUN });
      onEnd({ project: KEY, runId: RUN, code: 0 });
    }
    expect(messages('proj-a').map((m) => m.worker?.id)).toEqual(['W-1', 'W-2']);
  });

  it('a normal run is untouched', () => {
    onStart({ project: 'proj-a', runId: PARENT_RUN, agentId: 'claude' });
    expect(service.runningPaths().has('proj-a')).toBe(true);
    onOutput({ project: 'proj-a', runId: PARENT_RUN, line: text('hi') });
    onEnd({ project: 'proj-a', runId: PARENT_RUN, code: 0 });
    expect(messages('proj-a')).toHaveLength(1);
    expect(messages('proj-a')[0]?.worker).toBeUndefined();
  });

  it('the footer ignores a worker message for model and context, even when the worker runs the same agent', () => {
    service.selectedProject.set('proj-a');
    service.addMessage('proj-a', {
      id: 'c',
      role: 'assistant',
      agentId: 'claude',
      model: 'opus',
      usage: { inputTokens: 1_000, contextWindow: 200_000 },
    });
    service.addMessage('proj-a', {
      id: 'w',
      role: 'assistant',
      agentId: 'claude',
      model: 'small-model',
      worker: worker(),
      usage: { inputTokens: 50_000, contextWindow: 32_000 },
    });
    expect(service.activeModel()).toBe('opus');
    expect(service.contextUsageTokens()).toBe(1_000);
    expect(service.contextWindowTokens()).toBe(200_000);
  });
});
