import { NO_ERRORS_SCHEMA, signal } from '@angular/core';
import { Dialog } from '@angular/cdk/dialog';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TranslateModule } from '@ngx-translate/core';
import { IconComponent, TooltipDirective } from '@devia/ui';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppStateService } from '../../core/services/app-state.service';
import { ProjectAssetsService } from '../../core/services/project-assets.service';
import { ToastService } from '../../core/services/toast.service';
import { KanbanStateService } from '../../features/kanban/services/kanban-state.service';
import { RightRailComponent } from './right-rail.component';
import { RightRailStateService } from './services/right-rail-state.service';

describe('RightRailComponent — code graph button (S-44 T-506)', () => {
  let fixture: ComponentFixture<RightRailComponent>;
  const navigateByUrl = vi.fn(() => Promise.resolve(true));

  beforeEach(async () => {
    navigateByUrl.mockClear();
    await TestBed.configureTestingModule({
      imports: [RightRailComponent, TranslateModule.forRoot()],
      providers: [
        {
          provide: AppStateService,
          useValue: {
            selectedProject: signal<string | null>('proj-a'),
            splitActive: signal(false),
            dockerAvailable: signal(false),
            workdir: signal<string | null>('proj-a'),
            isRunning: () => false,
          },
        },
        {
          provide: RightRailStateService,
          useValue: {
            activeTab: signal(null),
            widthPx: signal(320),
            isOpen: signal(false),
            isResizing: signal(false),
            setWidth: vi.fn(),
            openTab: vi.fn(),
            toggleTab: vi.fn(),
          },
        },
        {
          provide: ProjectAssetsService,
          useValue: { skillCount: signal(0), mcpCount: signal(0), subAgentCount: signal(0) },
        },
        { provide: KanbanStateService, useValue: { board: signal(null), isPlanning: () => false } },
        { provide: ToastService, useValue: { show: vi.fn() } },
        { provide: Dialog, useValue: { open: vi.fn() } },
        { provide: Router, useValue: { navigateByUrl } },
      ],
    })
      .overrideComponent(RightRailComponent, {
        set: { imports: [TooltipDirective, IconComponent, TranslateModule], schemas: [NO_ERRORS_SCHEMA] },
      })
      .compileComponents();
    fixture = TestBed.createComponent(RightRailComponent);
    fixture.detectChanges();
  });

  const buttons = (): HTMLButtonElement[] =>
    Array.from((fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>('.dsr-rail-btn'));
  const graphButton = (): HTMLButtonElement | undefined =>
    buttons().find((b) => b.getAttribute('aria-label') === 'codeGraph.title');

  it('renders the code graph button right after the Kanban button', () => {
    const labels = buttons().map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf('codeGraph.title')).toBe(labels.indexOf('sdd.kanban_title') + 1);
  });

  it('navigates to /graph when clicked', () => {
    graphButton()?.click();
    expect(navigateByUrl).toHaveBeenCalledWith('/graph');
  });

  it('keeps the Kanban button navigating to /kanban', () => {
    buttons().find((b) => b.getAttribute('aria-label') === 'sdd.kanban_title')?.click();
    expect(navigateByUrl).toHaveBeenCalledWith('/kanban');
  });
});
