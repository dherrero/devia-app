import { describe, it, expect, beforeEach } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { StatusbarComponent } from './statusbar.component';
import { AppStateService } from '../../core/services/app-state.service';
import { ElectronApiService } from '../../core/services/electron-api.service';
import type { BillingMode } from '../../../../shared/domain/billing';
import type { GitInfo } from '../../../types/devia';

type StatusbarStub = {
  selectedProject: WritableSignal<string | null>;
  focusedKey: WritableSignal<string | null>;
  gitInfo: WritableSignal<GitInfo | null>;
  syncingGit: WritableSignal<boolean>;
  activeModel: WritableSignal<string | null>;
  contextPct: WritableSignal<number | null>;
  contextUsageTokens: WritableSignal<number | null>;
  contextWindowTokens: WritableSignal<number | null>;
  sessionCostUsd: WritableSignal<number | null>;
  sessionCostTurns: WritableSignal<readonly { turn: number; costUsd: number }[]>;
  currentBillingMode: WritableSignal<BillingMode>;
  runMode: WritableSignal<'plan' | 'apply' | 'apply-yolo'>;
  isRunning: (p: string) => boolean;
  syncGit: () => Promise<void>;
};

function makeStub(): StatusbarStub {
  return {
    selectedProject: signal<string | null>('/tmp/p'),
    focusedKey: signal<string | null>('/tmp/p'),
    gitInfo: signal<GitInfo | null>(null),
    syncingGit: signal<boolean>(false),
    activeModel: signal<string | null>(null),
    contextPct: signal<number | null>(null),
    contextUsageTokens: signal<number | null>(null),
    contextWindowTokens: signal<number | null>(null),
    sessionCostUsd: signal<number | null>(null),
    sessionCostTurns: signal<readonly { turn: number; costUsd: number }[]>([]),
    currentBillingMode: signal<BillingMode>('unknown'),
    runMode: signal<'plan' | 'apply' | 'apply-yolo'>('apply'),
    isRunning: () => false,
    syncGit: () => Promise.resolve(),
  };
}

describe('StatusbarComponent — centered group (S-1 T-3)', () => {
  let fixture: ComponentFixture<StatusbarComponent>;
  let stub: StatusbarStub;

  beforeEach(async () => {
    stub = makeStub();
    await TestBed.configureTestingModule({
      imports: [StatusbarComponent, TranslateModule.forRoot()],
      providers: [
        { provide: AppStateService, useValue: stub },
        { provide: ElectronApiService, useValue: { getAppVersion: () => Promise.resolve('9.9.9') } },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(StatusbarComponent);
  });

  // ── shortModel ──────────────────────────────────────────────────────────

  it('shortModel() strips the "claude-" prefix', () => {
    expect(fixture.componentInstance.shortModel('claude-opus-4-7')).toBe('opus-4-7');
  });

  it('shortModel() strips the "anthropic." prefix', () => {
    expect(fixture.componentInstance.shortModel('anthropic.claude-3')).toBe('claude-3');
  });

  it('shortModel() returns unprefixed model names unchanged', () => {
    expect(fixture.componentInstance.shortModel('gpt-5-mini')).toBe('gpt-5-mini');
    expect(fixture.componentInstance.shortModel('gemini-2.5-pro')).toBe('gemini-2.5-pro');
  });

  // ── center group visibility ─────────────────────────────────────────────

  it('does not render the center group when activeModel is null', () => {
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.center-group')).toBeNull();
  });

  it('renders the model label (shortened) when activeModel is set', () => {
    stub.activeModel.set('claude-opus-4-7');
    fixture.detectChanges();
    const label = fixture.nativeElement.querySelector('.model-label');
    expect(label).not.toBeNull();
    expect(label.textContent.trim()).toBe('opus-4-7');
  });

  // ── progress bar ────────────────────────────────────────────────────────

  it('does not render the progress bar when contextPct is null', () => {
    stub.activeModel.set('claude-opus-4-7');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.ctx')).toBeNull();
  });

  it('renders the progress bar fill with width matching contextPct', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.contextPct.set(0.25);
    fixture.detectChanges();
    const fill = fixture.nativeElement.querySelector('.ctx .bar .fill') as HTMLElement;
    expect(fill).not.toBeNull();
    expect(fill.style.width).toBe('25%');
  });

  it('adds .warn to bar and pct when contextPct >= 0.8', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.contextPct.set(0.85);
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('.ctx .bar');
    const pct = fixture.nativeElement.querySelector('.ctx .pct');
    expect(bar.classList.contains('warn')).toBe(true);
    expect(pct.classList.contains('warn')).toBe(true);
  });

  it('does NOT add .warn when contextPct is below 0.8', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.contextPct.set(0.5);
    fixture.detectChanges();
    const bar = fixture.nativeElement.querySelector('.ctx .bar');
    const pct = fixture.nativeElement.querySelector('.ctx .pct');
    expect(bar.classList.contains('warn')).toBe(false);
    expect(pct.classList.contains('warn')).toBe(false);
  });

  it('renders the percentage label rounded to whole numbers', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.contextPct.set(0.473);
    fixture.detectChanges();
    const pct = fixture.nativeElement.querySelector('.ctx .pct');
    expect(pct.textContent.trim()).toBe('47%');
  });

  // ── cost visibility ─────────────────────────────────────────────────────

  it('shows the cost when billingMode is "subscription" (cost is informational, not billing)', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.currentBillingMode.set('subscription');
    stub.sessionCostUsd.set(0.42);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cost')).not.toBeNull();
  });

  it('shows the cost when billingMode is "unknown" but the CLI reported a cost', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.currentBillingMode.set('unknown');
    stub.sessionCostUsd.set(0.42);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cost')).not.toBeNull();
  });

  it('hides the cost when sessionCostUsd is null', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.currentBillingMode.set('api');
    stub.sessionCostUsd.set(null);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cost')).toBeNull();
  });

  it('hides the cost when sessionCostUsd is 0', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.currentBillingMode.set('api');
    stub.sessionCostUsd.set(0);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.cost')).toBeNull();
  });

  it('shows the cost formatted as $X.YY when sessionCostUsd > 0', () => {
    stub.activeModel.set('claude-opus-4-7');
    stub.currentBillingMode.set('api');
    stub.sessionCostUsd.set(0.4237);
    fixture.detectChanges();
    const cost = fixture.nativeElement.querySelector('.cost');
    expect(cost).not.toBeNull();
    expect(cost.textContent.trim()).toBe('$0.42');
  });

  // ── cost tooltip breakdown (S-1 T-4) ──────────────────────────────────────

  it('costTooltip() returns just the header when there are no per-turn costs', () => {
    stub.sessionCostTurns.set([]);
    // No translations registered in the test module, so instant() echoes keys.
    expect(fixture.componentInstance.costTooltip()).toBe('statusbar.cost_tooltip');
  });

  it('costTooltip() lists one line per turn under the header', () => {
    stub.sessionCostTurns.set([
      { turn: 1, costUsd: 0.01 },
      { turn: 2, costUsd: 0.02 },
      { turn: 3, costUsd: 0.03 },
    ]);
    const lines = fixture.componentInstance.costTooltip().split('\n');
    expect(lines.length).toBe(4); // header + 3 turns
    expect(lines[0]).toBe('statusbar.cost_tooltip');
  });

  it('costTooltip() caps the breakdown at the last 8 turns', () => {
    const turns = Array.from({ length: 12 }, (_, i) => ({ turn: i + 1, costUsd: 0.01 }));
    stub.sessionCostTurns.set(turns);
    const lines = fixture.componentInstance.costTooltip().split('\n');
    expect(lines.length).toBe(9); // header + last 8 turns
  });
});
