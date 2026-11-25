/**
 * S-53 — the footer, stats, context and billing follow the EFFECTIVE agent of
 * the focused pane (session > project > global), asked of main and refreshed
 * when main announces a change.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { AppStateService } from './app-state.service';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import type { DeviaConfigView } from '../../../types/devia';
import type { EffectiveAgent, EffectiveAgentChangedEvent } from '../../../../shared/domain/effective-agent';

const noop = (): void => undefined;

function makeConfig(): DeviaConfigView {
  return {
    workspaceRoot: '/ws',
    ignoreFolders: [],
    agentId: 'claude',
    agentModels: { claude: { model: 'claude-opus-4-7' }, codex: { model: 'gpt-5-codex' } },
    agentCliEnv: {},
    agentToolPolicy: {},
    memory: { enabled: true, blockExternalMemory: true, engramImported: false },
    remoteControl: { allowShell: false, mirrorDesktop: false, allowFileSend: true, telegram: { enabled: false, botToken: '', chatId: '' } },
    configPath: '/cfg',
    hasWorkspace: true,
  } as unknown as DeviaConfigView;
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    TestBed.tick();
    await Promise.resolve();
  }
};

describe('AppStateService — effective agent (S-53)', () => {
  let service: AppStateService;
  let answer: (p: { projectPath: string; sessionId?: string }) => EffectiveAgent;
  let changed: ((e: EffectiveAgentChangedEvent) => void) | undefined;
  let getEffectiveAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    changed = undefined;
    answer = () => ({ agentId: 'claude', source: 'global' });
    getEffectiveAgent = vi.fn((p: { projectPath: string; sessionId?: string }) => Promise.resolve(answer(p)));
    const api: Record<string, unknown> = new Proxy(
      {
        platform: 'linux',
        isWSL: false,
        getRunModes: () => Promise.resolve([]),
        getEffectiveAgent,
        onEffectiveAgentChanged: (cb: (e: EffectiveAgentChangedEvent) => void) => { changed = cb; },
      } as Record<string, unknown>,
      { get: (t, k: string) => (k in t ? t[k] : noop) },
    );
    TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: api },
        { provide: ToastService, useValue: { show: vi.fn() } },
      ],
    });
    service = TestBed.inject(AppStateService);
    service['config'].set(makeConfig());
    service['wireBridgeEvents']();
  });

  it('shows the global agent until main answers', () => {
    service.selectedProject.set('proj-a');
    expect(service.effectiveAgentId()).toBe('claude');
  });

  it('adopts the project agent main reports and derives the model from it', async () => {
    answer = () => ({ agentId: 'codex', source: 'project' });
    service.selectedProject.set('proj-a');
    await flush();
    expect(getEffectiveAgent).toHaveBeenCalledWith({ projectPath: 'proj-a' });
    expect(service.effectiveAgent()).toEqual({ agentId: 'codex', source: 'project' });
    expect(service.activeModel()).toBe('gpt-5-codex');
  });

  it('asks again when the selected project changes', async () => {
    answer = ({ projectPath }) =>
      projectPath === 'proj-a' ? { agentId: 'codex', source: 'project' } : { agentId: 'claude', source: 'global' };
    service.selectedProject.set('proj-a');
    await flush();
    service.selectedProject.set('proj-b');
    await flush();
    expect(service.effectiveAgentId()).toBe('claude');
    expect(getEffectiveAgent).toHaveBeenLastCalledWith({ projectPath: 'proj-b' });
  });

  it('refreshes when main announces a change (e.g. Telegram or the global default)', async () => {
    service.selectedProject.set('proj-a');
    await flush();
    expect(service.effectiveAgentId()).toBe('claude');
    answer = () => ({ agentId: 'codex', source: 'project' });
    changed?.({});
    await flush();
    expect(service.effectiveAgentId()).toBe('codex');
  });

  it('ignores a stale answer that arrives after the project changed', async () => {
    let release!: (v: EffectiveAgent) => void;
    getEffectiveAgent.mockImplementationOnce(() => new Promise<EffectiveAgent>((r) => { release = r; }));
    service.selectedProject.set('proj-a');
    await flush();
    service.selectedProject.set('proj-b');
    await flush();
    release({ agentId: 'codex', source: 'project' }); // answer for proj-a, too late
    await flush();
    expect(service.effectiveAgentId()).toBe('claude');
  });
});
