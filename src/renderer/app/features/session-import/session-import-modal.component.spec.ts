import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { signal } from '@angular/core';
import { SessionImportModalComponent } from './session-import-modal.component';
import { ElectronApiService } from '../../core/services/electron-api.service';
import { AppStateService } from '../../core/services/app-state.service';
import type { ImportableAgent } from '../../../../shared/domain/session-import';

const AGENTS: ImportableAgent[] = [
  {
    agentId: 'claude',
    projects: [
      {
        projectPath: 'Eviatech/devia',
        projectName: 'devia',
        sessions: [
          { agentId: 'claude', sessionId: 'a', resumable: true, preview: 'haz X', title: 'Hacer X', messageCount: 4, createdAt: 1, updatedAt: 2, alreadyImported: false },
          { agentId: 'claude', sessionId: 'b', resumable: true, preview: 'ya', title: 'Ya', messageCount: 2, createdAt: 1, updatedAt: 1, alreadyImported: true },
        ],
      },
    ],
  },
  {
    agentId: 'codex',
    projects: [
      {
        projectPath: 'Eviatech/devia',
        projectName: 'devia',
        sessions: [
          { agentId: 'codex', sessionId: 'c', resumable: true, preview: 'codex turn', title: 'Codex', messageCount: 3, createdAt: 1, updatedAt: 3, alreadyImported: false },
        ],
      },
    ],
  },
];

describe('SessionImportModalComponent (S-20)', () => {
  let fixture: ComponentFixture<SessionImportModalComponent>;
  let api: { scanSessionImport: ReturnType<typeof vi.fn>; runSessionImport: ReturnType<typeof vi.fn> };

  beforeEach(async () => {
    api = {
      scanSessionImport: vi.fn().mockResolvedValue(AGENTS),
      runSessionImport: vi.fn().mockResolvedValue({ imported: 2, skipped: 0, failed: 0 }),
    };
    const state = { selectedProject: signal<string | null>(null), refreshSessions: vi.fn() };
    await TestBed.configureTestingModule({
      imports: [SessionImportModalComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: api },
        { provide: AppStateService, useValue: state },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(SessionImportModalComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  });

  it('scans on open and renders sessions grouped by agent', () => {
    expect(api.scanSessionImport).toHaveBeenCalledOnce();
    const host = fixture.nativeElement as HTMLElement;
    expect(host.querySelectorAll('.ci-agent')).toHaveLength(2);
    expect(host.querySelectorAll('.ci-session')).toHaveLength(3);
  });

  it('pre-selects only sessions that are not already imported, across agents', () => {
    const cmp = fixture.componentInstance;
    expect(cmp.isSelected('claude', 'Eviatech/devia', 'a')).toBe(true);
    expect(cmp.isSelected('claude', 'Eviatech/devia', 'b')).toBe(false);
    expect(cmp.isSelected('codex', 'Eviatech/devia', 'c')).toBe(true);
    expect(cmp.selectedCount()).toBe(2);
  });

  it('imports the selected sessions stamped with their agent', async () => {
    await fixture.componentInstance.runImport();
    expect(api.runSessionImport).toHaveBeenCalledWith(
      [
        { agentId: 'claude', projectPath: 'Eviatech/devia', sessionId: 'a' },
        { agentId: 'codex', projectPath: 'Eviatech/devia', sessionId: 'c' },
      ],
      { force: false },
    );
  });

  it('toggles every selectable session in a project from the header', () => {
    const cmp = fixture.componentInstance;
    const project = AGENTS[0]!.projects[0]!;
    expect(cmp.isProjectAllSelected('claude', project)).toBe(true);
    cmp.toggleProject('claude', project); // deselect
    expect(cmp.isSelected('claude', 'Eviatech/devia', 'a')).toBe(false);
    cmp.toggleProject('claude', project); // re-select
    expect(cmp.isSelected('claude', 'Eviatech/devia', 'a')).toBe(true);
  });

  it('global toggle selects and clears every selectable session', () => {
    const cmp = fixture.componentInstance;
    expect(cmp.isAllSelected()).toBe(true);
    cmp.toggleAll();
    expect(cmp.selectedCount()).toBe(0);
    cmp.toggleAll();
    expect(cmp.selectedCount()).toBe(2);
  });

  it('locks already-imported sessions until force is enabled', () => {
    const cmp = fixture.componentInstance;
    expect(cmp.isLocked(true)).toBe(true);
    cmp.onForceChange(true);
    expect(cmp.isLocked(true)).toBe(false);
  });
});
