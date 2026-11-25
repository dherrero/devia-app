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
  let setContextAgent: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    changed = undefined;
    answer = () => ({ agentId: 'claude', source: 'global' });
    getEffectiveAgent = vi.fn((p: { projectPath: string; sessionId?: string }) => Promise.resolve(answer(p)));
    setContextAgent = vi.fn();
    const api: Record<string, unknown> = new Proxy(
      {
        platform: 'linux',
        isWSL: false,
        getRunModes: () => Promise.resolve([]),
        getEffectiveAgent,
        setContextAgent,
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

  it('asks again when the primary pane switches to another session of the same project', async () => {
    service.selectedProject.set('proj-a');
    service.availableSessions.set([{ id: 's1', isActive: true } as never, { id: 's2', isActive: false } as never]);
    await flush();
    getEffectiveAgent.mockClear();
    answer = () => ({ agentId: 'pi', source: 'session' });
    service.availableSessions.set([{ id: 's1', isActive: false } as never, { id: 's2', isActive: true } as never]);
    await flush();
    expect(getEffectiveAgent).toHaveBeenCalledTimes(1);
    expect(service.effectiveAgentId()).toBe('pi');
  });

  describe('setProjectAgent', () => {
    it('sets the agent of the selected project and asks main for the new effective agent', async () => {
      service.selectedProject.set('proj-a');
      await flush();
      getEffectiveAgent.mockClear();
      answer = () => ({ agentId: 'codex', source: 'project' });
      setContextAgent.mockResolvedValue({ accepted: true, effective: { agentId: 'codex', source: 'project' } });

      const result = await service.setProjectAgent('codex');
      await flush();

      expect(setContextAgent).toHaveBeenCalledWith({ scope: 'project', projectPath: 'proj-a', agentId: 'codex' });
      expect(result.accepted).toBe(true);
      expect(getEffectiveAgent).toHaveBeenCalled();
      expect(service.effectiveAgentId()).toBe('codex');
    });

    it('passes null to go back to the default and reports a rejection untouched', async () => {
      service.selectedProject.set('proj-a');
      setContextAgent.mockResolvedValue({
        accepted: false, effective: { agentId: 'claude', source: 'global' }, rejectedReason: 'AGENT_RUN_ACTIVE',
      });
      const result = await service.setProjectAgent(null);
      expect(setContextAgent).toHaveBeenCalledWith({ scope: 'project', projectPath: 'proj-a', agentId: null });
      expect(result).toMatchObject({ accepted: false, rejectedReason: 'AGENT_RUN_ACTIVE' });
    });

    it('rejects without calling main when no project is selected', async () => {
      const result = await service.setProjectAgent('codex');
      expect(result).toMatchObject({ accepted: false, rejectedReason: 'NO_PROJECT' });
      expect(setContextAgent).not.toHaveBeenCalled();
    });
  });

  describe('setFocusedAgent / agentTarget', () => {
    const SID = '33333333-2222-4333-8333-555555555555';
    beforeEach(() => {
      service.selectedProject.set('proj-a');
      setContextAgent.mockResolvedValue({ accepted: true, effective: { agentId: 'codex', source: 'session' } });
    });

    it('the primary pane without a session agent targets the PROJECT', async () => {
      expect(service.agentTarget()).toBe('project');
      await service.setFocusedAgent('codex');
      expect(setContextAgent).toHaveBeenCalledWith({ scope: 'project', projectPath: 'proj-a', agentId: 'codex' });
    });

    it('an additional pane targets its own SESSION, even before that session exists on disk', async () => {
      service.focusedSessionKey.set(SID);
      expect(service.agentTarget()).toBe('session');
      await service.setFocusedAgent('codex');
      expect(setContextAgent).toHaveBeenCalledWith({ scope: 'session', projectPath: 'proj-a', sessionId: SID, agentId: 'codex' });
    });

    it('the primary pane whose session already has its own agent keeps writing to that session', async () => {
      answer = () => ({ agentId: 'pi', source: 'session' });
      service.availableSessions.set([{ id: SID, isActive: true } as never]);
      await flush();
      expect(service.agentTarget()).toBe('session');
      await service.setFocusedAgent(null);
      expect(setContextAgent).toHaveBeenCalledWith({ scope: 'session', projectPath: 'proj-a', sessionId: SID, agentId: null });
    });

    it('rejects without calling main when there is no project', async () => {
      service.selectedProject.set(null);
      const result = await service.setFocusedAgent('codex');
      expect(result).toMatchObject({ accepted: false, rejectedReason: 'NO_PROJECT' });
      expect(setContextAgent).not.toHaveBeenCalled();
    });
  });
});
