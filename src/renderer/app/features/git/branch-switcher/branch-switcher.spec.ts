import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { groupBranches } from './branch-switcher.component';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import type { BranchRef } from '../../../../../shared/domain/git';

const noop = (): void => undefined;

function ref(name: string, isRemote: boolean): BranchRef {
  return { name, isRemote, isCurrent: false, shortSha: 'abc', lastCommitTs: 0, subject: '' };
}

describe('groupBranches (pure)', () => {
  const all: BranchRef[] = [
    ref('dev', false),
    ref('feature/login', false),
    ref('origin/dev', true),
    ref('origin/main', true),
  ];

  it('splits local and remote preserving order', () => {
    const g = groupBranches(all, '');
    expect(g.local.map((b) => b.name)).toEqual(['dev', 'feature/login']);
    expect(g.remote.map((b) => b.name)).toEqual(['origin/dev', 'origin/main']);
  });

  it('filters both groups case-insensitively by substring', () => {
    const g = groupBranches(all, 'DEV');
    expect(g.local.map((b) => b.name)).toEqual(['dev']);
    expect(g.remote.map((b) => b.name)).toEqual(['origin/dev']);
  });

  it('returns empty groups when nothing matches', () => {
    const g = groupBranches(all, 'zzz');
    expect(g.local).toEqual([]);
    expect(g.remote).toEqual([]);
  });
});

describe('AppStateService.checkoutBranch — guards', () => {
  let service: AppStateService;
  let api: {
    listBranches: ReturnType<typeof vi.fn>;
    checkoutBranch: ReturnType<typeof vi.fn>;
    pullGit: ReturnType<typeof vi.fn>;
  };
  let toast: { show: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      listBranches: vi.fn(async () => []),
      checkoutBranch: vi.fn(async () => ({ ok: true, branch: 'x', message: 'Cambiado a x.' })),
      pullGit: vi.fn(async () => ({ ok: true, message: 'Pull completado.' })),
    };
    toast = { show: vi.fn() };
    const mockApi = {
      platform: 'linux',
      isWSL: false,
      onClaudeOutput: noop, onProcessStart: noop, onProcessEnd: noop, onSessionHandoff: noop,
      onSessionReset: noop, onComposeStart: noop, onComposeOutput: noop, onComposeEnd: noop,
      onOutboxFile: noop, onCloneStart: noop, onCloneOutput: noop, onCloneEnd: noop,
      onGitInfoChanged: noop, onConfigChanged: noop, onNotificationClick: noop, onAgentChanged: noop,
      onQueueChanged: noop, onQueueDispatched: noop, onTerminalData: noop, onTerminalExit: noop,
      onQuestionAsk: noop, onDiffSnapshot: noop, onAgentsDetected: noop, onSkillRegistryChanged: noop,
      onMcpListChanged: noop, onSubAgentsChanged: noop, onKanbanChanged: noop, onAgentWake: noop,
      onSddNotification: noop, onRemoteControlStatus: noop, onRemoteSelectProject: noop,
      onRunModeChanged: noop, getRunModes: () => Promise.resolve([]), setRunModeRemote: () => Promise.resolve(),
      ...api,
    } as unknown as ElectronApiService;

    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: toast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
    service['selectedProject'].set('proj');
    service['gitInfo'].set({ branch: 'dev', dirty: false, defaultBranch: 'main', ahead: 0, behind: 0, changedCount: 0 });
    vi.spyOn(service, 'refreshGit').mockResolvedValue(undefined as never);
  });

  it('blocks the checkout while a split is active', async () => {
    service.setSplitActive(true);
    const ok = await service.checkoutBranch({ name: 'x', isRemote: false });
    expect(ok).toBe(false);
    expect(api.checkoutBranch).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith('app_state.git_checkout_blocked_split', expect.anything());
  });

  it('blocks the checkout while the project agent is running', async () => {
    service['runningPaths'].set(new Set(['proj']));
    const ok = await service.checkoutBranch({ name: 'x', isRemote: false });
    expect(ok).toBe(false);
    expect(api.checkoutBranch).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith('app_state.git_checkout_blocked_running', expect.anything());
  });

  it('performs the checkout and reports success when no guard blocks it', async () => {
    const ok = await service.checkoutBranch({ name: 'x', isRemote: false });
    expect(ok).toBe(true);
    expect(api.checkoutBranch).toHaveBeenCalledWith('proj', { name: 'x', isRemote: false });
    expect(toast.show).toHaveBeenCalledWith('app_state.git_checkout_success', expect.objectContaining({ kind: 'success' }));
    expect(service.refreshGit).toHaveBeenCalledWith('proj');
  });
});

describe('AppStateService.pullGit — guards', () => {
  let service: AppStateService;
  let api: { pullGit: ReturnType<typeof vi.fn> };
  let toast: { show: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = { pullGit: vi.fn(async () => ({ ok: true, message: 'Pull completado.' })) };
    toast = { show: vi.fn() };
    const mockApi = {
      platform: 'linux',
      isWSL: false,
      onClaudeOutput: noop, onProcessStart: noop, onProcessEnd: noop, onSessionHandoff: noop,
      onSessionReset: noop, onComposeStart: noop, onComposeOutput: noop, onComposeEnd: noop,
      onOutboxFile: noop, onCloneStart: noop, onCloneOutput: noop, onCloneEnd: noop,
      onGitInfoChanged: noop, onConfigChanged: noop, onNotificationClick: noop, onAgentChanged: noop,
      onQueueChanged: noop, onQueueDispatched: noop, onTerminalData: noop, onTerminalExit: noop,
      onQuestionAsk: noop, onDiffSnapshot: noop, onAgentsDetected: noop, onSkillRegistryChanged: noop,
      onMcpListChanged: noop, onSubAgentsChanged: noop, onKanbanChanged: noop, onAgentWake: noop,
      onSddNotification: noop, onRemoteControlStatus: noop, onRemoteSelectProject: noop,
      onRunModeChanged: noop, getRunModes: () => Promise.resolve([]), setRunModeRemote: () => Promise.resolve(),
      ...api,
    } as unknown as ElectronApiService;

    await TestBed.configureTestingModule({
      imports: [TranslateModule.forRoot()],
      providers: [
        AppStateService,
        { provide: ElectronApiService, useValue: mockApi },
        { provide: ToastService, useValue: toast },
      ],
    }).compileComponents();
    service = TestBed.inject(AppStateService);
    service['selectedProject'].set('proj');
    vi.spyOn(service, 'refreshGit').mockResolvedValue(undefined as never);
  });

  it('blocks the pull while the project agent is running', async () => {
    service['runningPaths'].set(new Set(['proj']));
    const ok = await service.pullGit();
    expect(ok).toBe(false);
    expect(api.pullGit).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith('app_state.git_pull_blocked_running', expect.anything());
  });

  it('pulls and reports success when no guard blocks it', async () => {
    const ok = await service.pullGit();
    expect(ok).toBe(true);
    expect(api.pullGit).toHaveBeenCalledWith('proj');
    expect(toast.show).toHaveBeenCalledWith('app_state.git_pull_success', expect.objectContaining({ kind: 'success' }));
    expect(service.refreshGit).toHaveBeenCalledWith('proj');
  });
});
