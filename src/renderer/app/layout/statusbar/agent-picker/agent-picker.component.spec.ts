/**
 * S-53 — footer agent picker: chooses the agent of the SELECTED PROJECT
 * (Settings keeps choosing the global default).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { signal } from '@angular/core';
import { TranslateModule } from '@ngx-translate/core';
import { DialogRef } from '@devia/ui';
import { AgentPickerComponent, buildAgentPickerItems } from './agent-picker.component';
import { AppStateService } from '../../../core/services/app-state.service';
import { AgentSwitchHandoffService } from '../../../core/services/agent-switch-handoff.service';
import { ToastService } from '../../../core/services/toast.service';
import { KeyboardShortcutsService } from '../../../core/layout/keyboard-shortcuts.service';
import type { EffectiveAgent } from '../../../../../shared/domain/effective-agent';

const AGENTS = [
  { id: 'claude', name: 'Claude Code', available: true, selectable: true },
  { id: 'codex', name: 'Codex', available: true, selectable: true },
  { id: 'gemini', name: 'Gemini', available: false, selectable: true },
  { id: 'api-x', name: 'API X', available: true, selectable: false },
];

describe('buildAgentPickerItems', () => {
  it('lists only agents that are installed and selectable, marking the current one', () => {
    const items = buildAgentPickerItems(AGENTS as never, 'codex');
    expect(items.map((i) => i.id)).toEqual(['claude', 'codex']);
    expect(items.find((i) => i.id === 'codex')?.current).toBe(true);
    expect(items.find((i) => i.id === 'claude')?.current).toBe(false);
  });
});

describe('AgentPickerComponent', () => {
  let fixture: ComponentFixture<AgentPickerComponent>;
  let effective: ReturnType<typeof signal<EffectiveAgent | null>>;
  let effectiveId: ReturnType<typeof signal<string>>;
  const state = { setFocusedAgent: vi.fn() };
  let target: ReturnType<typeof signal<'project' | 'session'>>;
  const handoff = { notify: vi.fn() };
  const toast = { show: vi.fn() };
  const shortcuts = { openSettings: vi.fn() };
  const dialogRef = { close: vi.fn() };

  beforeEach(async () => {
    effective = signal<EffectiveAgent | null>({ agentId: 'claude', source: 'global' });
    effectiveId = signal('claude');
    state.setFocusedAgent.mockReset();
    target = signal<'project' | 'session'>('project');
    handoff.notify.mockReset();
    toast.show.mockReset();
    shortcuts.openSettings.mockReset();
    dialogRef.close.mockReset();
    await TestBed.configureTestingModule({
      imports: [AgentPickerComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: { ...state, detectedAgents: signal(AGENTS), effectiveAgent: effective, effectiveAgentId: effectiveId, agentTarget: target } },
        { provide: AgentSwitchHandoffService, useValue: handoff },
        { provide: ToastService, useValue: toast },
        { provide: KeyboardShortcutsService, useValue: shortcuts },
        { provide: DialogRef, useValue: dialogRef },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(AgentPickerComponent);
    fixture.detectChanges();
  });

  const items = (): HTMLButtonElement[] =>
    Array.from(fixture.nativeElement.querySelectorAll('.agent-item')) as HTMLButtonElement[];

  it('renders the installed agents and highlights the current one', () => {
    expect(items().map((b) => b.textContent?.trim())).toEqual(expect.arrayContaining(['Claude Code', 'Codex']));
    expect(items()).toHaveLength(2);
    expect(items().find((b) => b.textContent?.includes('Claude'))?.classList.contains('current')).toBe(true);
  });

  it('sets the project agent, announces a possible handoff and closes', async () => {
    state.setFocusedAgent.mockResolvedValue({ accepted: true, effective: { agentId: 'codex', source: 'project' } });
    await fixture.componentInstance.pick('codex');
    expect(state.setFocusedAgent).toHaveBeenCalledWith('codex');
    expect(handoff.notify).toHaveBeenCalledWith('claude', 'codex');
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('keeps the dialog open and says why when main refuses (run active)', async () => {
    state.setFocusedAgent.mockResolvedValue({
      accepted: false, effective: { agentId: 'claude', source: 'global' }, rejectedReason: 'AGENT_RUN_ACTIVE',
    });
    await fixture.componentInstance.pick('codex');
    expect(handoff.notify).not.toHaveBeenCalled();
    expect(dialogRef.close).not.toHaveBeenCalled();
    expect(toast.show).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ kind: 'error' }));
  });

  it('offers "use the default" only when the project has its own agent', async () => {
    expect(fixture.nativeElement.querySelector('.use-default')).toBeNull();
    effective.set({ agentId: 'codex', source: 'project' });
    effectiveId.set('codex');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.use-default')).not.toBeNull();
    state.setFocusedAgent.mockResolvedValue({ accepted: true, effective: { agentId: 'claude', source: 'global' } });
    await fixture.componentInstance.pick(null);
    expect(state.setFocusedAgent).toHaveBeenCalledWith(null);
    expect(handoff.notify).toHaveBeenCalledWith('codex', 'claude');
  });

  it('picking the agent already in use changes nothing', async () => {
    await fixture.componentInstance.pick('claude');
    expect(state.setFocusedAgent).not.toHaveBeenCalled();
    expect(dialogRef.close).toHaveBeenCalled();
  });

  it('opens Settings › Execution and closes, without touching the project agent', () => {
    fixture.componentInstance.openSettings();
    expect(shortcuts.openSettings).toHaveBeenCalledWith('execution');
    expect(dialogRef.close).toHaveBeenCalled();
    expect(state.setFocusedAgent).not.toHaveBeenCalled();
  });

  it('on a split pane the dialog talks about the pane, and "back to default" means the project agent', () => {
    target.set('session');
    effective.set({ agentId: 'codex', source: 'session' });
    effectiveId.set('codex');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ap-hint')?.textContent).toContain('statusbar.agent_picker_hint_session');
    expect(fixture.nativeElement.querySelector('.use-default')?.textContent).toContain('statusbar.agent_use_project');
  });

  it('a pane that still follows its project offers no "back" action', () => {
    target.set('session');
    effective.set({ agentId: 'codex', source: 'project' });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.use-default')).toBeNull();
  });
});
