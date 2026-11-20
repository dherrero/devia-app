/**
 * UC-FIX-019 — Real Angular TestBed tests for ToolCallCardComponent.
 *
 * Tests focus on the pure computed signals which carry production logic:
 * isRunning, statusIcon, statusClass, hasDiff, formattedInput, truncatedResult.
 * One DOM assertion per key scenario is also included.
 *
 * Extended with:
 * - Bash terminal render (① BURBUJA-TERMINAL)
 * - File chip clicable (② CHIPS DE FICHERO)
 * - TodoWrite checklist (③ TARJETA-PLAN/TODO)
 * - Review changes button (④ DIFF → REVISAR EN CAMBIOS)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { signal, type Type } from '@angular/core';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { LucideNetwork, LucideLayoutDashboard, LucideBot, LucideCodeXml } from '@lucide/angular';
import { ToolCallCardComponent } from './tool-call-card.component';
import { ToolTerminalBlockComponent } from './components/tool-terminal-block/tool-terminal-block.component';
import { ToolTodoBlockComponent } from './components/tool-todo-block/tool-todo-block.component';
import { ToolGenericBlockComponent } from './components/tool-generic-block/tool-generic-block.component';
import { ToolDiffSectionComponent } from './components/tool-diff-section/tool-diff-section.component';
import { formatToolInput } from './utils/tool-call-view.utils';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import { AppStateService } from '../../../../../core/services/app-state.service';
import { ProjectAssetsService } from '../../../../../core/services/project-assets.service';
import type { ToolCallRecord } from '../../../../../../../shared/domain/chat';
import type { McpServerView } from '../../../../../../types/devia';

// ── Minimal stubs ─────────────────────────────────────────────────────────

const mockApi: Partial<ElectronApiService> = {
  platform: 'linux',
  getGitDiff: () => Promise.resolve({ hasChanges: false, files: [] } as never),
  openInIde: vi.fn().mockResolvedValue(undefined),
  openPath: vi.fn().mockResolvedValue(undefined),
  revealInFolder: vi.fn().mockResolvedValue(undefined),
};

// The diff path renders DiffViewerComponent, which reads config() and the
// writable focusedDiffFile signal off the shared state.
const focusedDiffFileSignal = signal<string | null>(null);
const mockState: Partial<AppStateService> = {
  config: (() => null) as never,
  focusedDiffFile: focusedDiffFileSignal,
};

const mockAssets: Partial<ProjectAssetsService> = {
  mcpServers: signal<McpServerView[]>([]).asReadonly(),
};

function makeTc(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return { id: 'tc-test', name: 'Bash', ...overrides } as ToolCallRecord;
}

// ── Setup ─────────────────────────────────────────────────────────────────

describe('ToolCallCardComponent — pure computeds', () => {
  let fixture: ComponentFixture<ToolCallCardComponent>;

  /** Returns the mounted body-block subcomponent instance of the given type. */
  function childInstance<T>(type: Type<T>): T {
    const debugEl = fixture.debugElement.query(By.directive(type));
    expect(debugEl).not.toBeNull();
    return debugEl.componentInstance as T;
  }

  beforeEach(async () => {
    // Reset the shared focusedDiffFile before each test
    focusedDiffFileSignal.set(null);
    vi.clearAllMocks();

    await TestBed.configureTestingModule({
      imports: [ToolCallCardComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: mockApi },
        { provide: AppStateService, useValue: mockState },
        { provide: ProjectAssetsService, useValue: mockAssets },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ToolCallCardComponent);
  });

  it('toolIconLucide() uses the graph (network) icon for devia-code-graph calls and keeps kanban apart (S-48)', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'mcp__devia-code-graph__graph_explore' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.toolIconLucide()).toBe(LucideNetwork);
    fixture.componentRef.setInput('toolCall', makeTc({ id: 'tc-2', name: 'mcp__devia-kanban__kanban_list' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.toolIconLucide()).toBe(LucideLayoutDashboard);
  });

  // ── isRunning ──────────────────────────────────────────────────────────

  it('isRunning() is true when result is absent', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isRunning()).toBe(true);
  });

  it('isRunning() is false when result is absent but the parent message is inactive', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read' }));
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    expect(fixture.componentInstance.isRunning()).toBe(false);
    expect(fixture.componentInstance.statusClass()).toBe('done');
  });

  it('isRunning() is false when result is present', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ result: 'done', isError: false }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isRunning()).toBe(false);
  });

  it('isRunning() is false when isError is true even without result', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ isError: true }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isRunning()).toBe(false);
  });

  // ── summary & statusClass ──────────────────────────────────────────────

  it('statusClass() is "done" on success', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ result: 'ok', isError: false }));
    fixture.detectChanges();
    expect(fixture.componentInstance.statusClass()).toBe('done');
  });

  it('statusClass() is "error" when isError', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ isError: true, result: 'fail' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.statusClass()).toBe('error');
  });

  it('summary() reports line count for a completed Read', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read', result: 'a\nb\nc' }));
    fixture.detectChanges();
    const s = fixture.componentInstance.summary();
    expect(s.state).toBe('success');
    expect(s.key).toBe('tool_summary.lines');
    expect(s.params?.count).toBe(3);
  });

  // ── filePathArg (cross-agent shapes) ───────────────────────────────────

  it('filePathArg() reads file_path for a Claude Edit', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Edit', input: { file_path: '/src/a.ts' } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.filePathArg()).toBe('/src/a.ts');
  });

  it('filePathArg() derives the path from a non-Claude {changes} edit', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      input: { changes: [{ path: 'src/b.ts' }] },
    }));
    fixture.detectChanges();
    expect(fixture.componentInstance.filePathArg()).toBe('src/b.ts');
  });

  it('headerArg() returns the command for Bash', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash', input: { command: 'git status' } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.headerArg()).toBe('git status');
  });

  it('headerArg() shows a cleaned command but keeps the raw command as title', () => {
    const command = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command \'Get-Content AGENTS.md\'';
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash', input: { command } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.headerArg()).toBe('Get-Content AGENTS.md');
    expect(fixture.componentInstance.headerArgTitle()).toBe(command);
  });

  it('displayTitle() maps Bash to a semantic translated title key', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.displayTitle()).toEqual({
      key: 'tool_card.title.terminal',
      params: undefined,
    });
  });

  it('displayTitle() maps AskUserQuestion to a user-facing question title key', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'AskUserQuestion' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.displayTitle()).toEqual({
      key: 'tool_card.title.question',
      params: undefined,
    });
  });

  it('displayTitle() keeps unknown tools in a generic translated title', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'CustomThing' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.displayTitle()).toEqual({
      key: 'tool_card.title.generic',
      params: { name: 'CustomThing' },
    });
  });

  // ── hasDiff ───────────────────────────────────────────────────────────

  it('hasDiff() is false for a Bash tool with no diff', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.hasDiff()).toBe(false);
  });

  it('hasDiff() is true for Edit with diff array', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      diff: [{ oldPath: undefined, path: 'a.ts', status: 'modified', lines: [] }],
    }));
    fixture.detectChanges();
    expect(fixture.componentInstance.hasDiff()).toBe(true);
  });

  it('hasDiff() is false for Edit with empty diff array', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Edit', diff: [] }));
    fixture.detectChanges();
    expect(fixture.componentInstance.hasDiff()).toBe(false);
  });

  // ── formattedInput ────────────────────────────────────────────────────

  it('formattedInput() returns command for Bash', () => {
    expect(formatToolInput(makeTc({ name: 'Bash', input: { command: 'git status' } }))).toBe('git status');
  });

  it('terminalCommand() cleans shell wrappers while rawTerminalCommand() preserves them', () => {
    const command = 'bash -lc "npm test"';
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash', input: { command } }));
    fixture.detectChanges();
    const terminal = childInstance(ToolTerminalBlockComponent);
    expect(terminal.terminalCommand()).toBe('npm test');
    expect(terminal.rawTerminalCommand()).toBe(command);
  });

  it('formattedInput() returns file_path for Read', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read', input: { file_path: '/src/app.ts' } }));
    fixture.detectChanges();
    expect(childInstance(ToolGenericBlockComponent).formattedInput()).toBe('/src/app.ts');
  });

  it('formattedInput() returns question for AskUserQuestion', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'AskUserQuestion',
      input: { question: 'Shall I proceed?' },
    }));
    fixture.detectChanges();
    expect(childInstance(ToolGenericBlockComponent).formattedInput()).toBe('Shall I proceed?');
  });

  // ── truncatedResult ───────────────────────────────────────────────────

  it('AC4: truncatedResult() adds [truncated] suffix for results > 2000 chars', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      result: 'x'.repeat(2500),
      isError: false,
    }));
    fixture.detectChanges();
    expect(childInstance(ToolTerminalBlockComponent).truncatedResult()).toContain('[truncated]');
  });

  it('truncatedResult() leaves short results intact', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ result: 'short output', isError: false }));
    fixture.detectChanges();
    expect(childInstance(ToolTerminalBlockComponent).truncatedResult()).toBe('short output');
  });

  // ── DOM assertion ─────────────────────────────────────────────────────

  it('AC1: renders Bash command in .tc-terminal-cmd for Bash tool', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Bash',
      input: { command: 'git status' },
      result: 'output',
      isError: false,
    }));
    // open the card
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const terminalCmd = el.querySelector('.tc-terminal-cmd');
    expect(terminalCmd).not.toBeNull();
    expect(terminalCmd?.textContent).toContain('git status');
  });

  it('AC2: .tc-status-pill with data-state="error" when isError', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ isError: true, result: 'EACCES' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const pill = el.querySelector('.tc-status-pill');
    expect(pill).not.toBeNull();
    expect(pill?.getAttribute('data-state')).toBe('error');
  });

  it('AC3: .tc-spin is rendered inside the pill when running (no result)', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tc-status-pill[data-state="running"] .tc-spin')).not.toBeNull();
  });

  it('does not render .tc-spin for an unfinished tool after the parent message ends', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read' }));
    fixture.componentRef.setInput('active', false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tc-status-pill[data-state="running"] .tc-spin')).toBeNull();
    expect(el.querySelector('.tc-status-pill[data-state="done"] .tc-spin')).toBeNull();
  });

  // ── ① BURBUJA-TERMINAL ────────────────────────────────────────────────

  it('renders tc-terminal block (not tc-input) for Bash tool', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Bash',
      input: { command: 'npm test' },
      result: 'passed',
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tc-terminal')).not.toBeNull();
    expect(el.querySelector('.tc-input')).toBeNull();
  });

  it('renders tc-terminal block for Execute tool', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Execute',
      input: { command: 'ls -la' },
      result: 'total 0',
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tc-terminal')).not.toBeNull();
  });

  it('tc-terminal--error class applied when isError for Bash', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Bash',
      input: { command: 'bad cmd' },
      result: 'error',
      isError: true,
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.tc-terminal--error')).not.toBeNull();
  });

  it('terminal copy buttons are present in terminal block', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Bash',
      input: { command: 'echo hi' },
      result: 'hi',
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const btns = el.querySelectorAll('.tc-terminal-header dv-button, .tc-terminal-output-header dv-button');
    expect(btns.length).toBeGreaterThanOrEqual(2);
  });

  it('isTerminalTool() is true for Bash and Execute, false for Read', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isTerminalTool()).toBe(true);

    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Execute' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isTerminalTool()).toBe(true);

    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Read', input: { file_path: '/a.ts' } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isTerminalTool()).toBe(false);
  });

  // ── ② CHIPS DE FICHERO CLICABLES ─────────────────────────────────────

  it('renders the file chip action for Edit tool with file_path', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      input: { file_path: '/src/foo.ts' },
      result: '',
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const chip = el.querySelector('.tc-file-chip-row .tc-file-chip');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toContain('/src/foo.ts');
  });

  it('file chip row has a secondary reveal-folder button', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Read',
      input: { file_path: '/src/bar.ts' },
      result: 'content',
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const secondary = el.querySelector('.tc-file-chip-row .tc-file-chip + .tc-file-chip');
    expect(secondary).not.toBeNull();
  });

  it('openFileInIde() calls api.openInIde with the path', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      input: { file_path: '/src/test.ts' },
    }));
    fixture.detectChanges();
    childInstance(ToolGenericBlockComponent).openFileInIde('/src/test.ts');
    expect(mockApi.openInIde).toHaveBeenCalledWith('/src/test.ts');
  });

  it('revealFile() calls api.revealInFolder with the path', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Read',
      input: { file_path: '/src/test.ts' },
    }));
    fixture.detectChanges();
    childInstance(ToolGenericBlockComponent).revealFile('/src/test.ts');
    expect(mockApi.revealInFolder).toHaveBeenCalledWith('/src/test.ts');
  });

  // ── ③ TARJETA-PLAN/TODO ───────────────────────────────────────────────

  it('isTodoTool() is true for TodoWrite', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'TodoWrite', input: { todos: [] } }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isTodoTool()).toBe(true);
  });

  it('isTodoTool() is false for Bash', () => {
    fixture.componentRef.setInput('toolCall', makeTc({ name: 'Bash' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.isTodoTool()).toBe(false);
  });

  it('todoItems() parses a valid todos array', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Task A', status: 'completed' },
          { content: 'Task B', status: 'in_progress' },
          { content: 'Task C', status: 'pending' },
        ],
      },
    }));
    fixture.detectChanges();
    const items = childInstance(ToolTodoBlockComponent).todoItems();
    expect(items).not.toBeNull();
    expect(items?.length).toBe(3);
    expect(items?.[0].status).toBe('completed');
    expect(items?.[1].status).toBe('in_progress');
    expect(items?.[2].status).toBe('pending');
  });

  it('todoDone() counts only completed items', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Task A', status: 'completed' },
          { content: 'Task B', status: 'completed' },
          { content: 'Task C', status: 'pending' },
        ],
      },
    }));
    fixture.detectChanges();
    expect(childInstance(ToolTodoBlockComponent).todoDone()).toBe(2);
  });

  it('renders X/Y plan progress text for TodoWrite', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Task A', status: 'completed' },
          { content: 'Task B', status: 'pending' },
          { content: 'Task C', status: 'pending' },
        ],
      },
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const header = el.querySelector('.tc-todo');
    expect(header).not.toBeNull();
    // The progress text element must be present
    expect(el.querySelector('.tc-todo-progress-text')).not.toBeNull();
  });

  it('renders checklist items with correct data-status attributes', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Done task', status: 'completed' },
          { content: 'Active task', status: 'in_progress' },
        ],
      },
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const items = el.querySelectorAll('.tc-todo-item');
    expect(items.length).toBe(2);
    expect(items[0].getAttribute('data-status')).toBe('completed');
    expect(items[1].getAttribute('data-status')).toBe('in_progress');
  });

  it('todoItems() returns null and falls back when todos array is empty', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'TodoWrite',
      input: { todos: [] },
    }));
    fixture.detectChanges();
    expect(childInstance(ToolTodoBlockComponent).todoItems()).toBeNull();
  });

  it('todoItems() returns null when input has no todos key', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'TodoWrite',
      input: { other: 'data' },
    }));
    fixture.detectChanges();
    expect(childInstance(ToolTodoBlockComponent).todoItems()).toBeNull();
  });

  // ── ④ DIFF → "REVISAR EN CAMBIOS" ────────────────────────────────────

  it('renders the review action in the diff summary when hasDiff and filePathArg', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      input: { file_path: '/src/foo.ts' },
      diff: [{ path: 'src/foo.ts', status: 'modified', lines: [] }],
    }));
    fixture.componentInstance.collapsed.set(false);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    // Open the details element to make the summary accessible
    const details = el.querySelector('details');
    if (details) details.setAttribute('open', '');
    fixture.detectChanges();
    expect(el.querySelector('.tc-review-action-slot dv-button')).not.toBeNull();
  });

  it('focusDiff() sets state.focusedDiffFile to the given path', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      input: { file_path: '/src/bar.ts' },
      diff: [{ path: 'src/bar.ts', status: 'modified', lines: [] }],
    }));
    fixture.detectChanges();
    const fakeEvent = { stopPropagation: vi.fn() } as unknown as Event;
    childInstance(ToolDiffSectionComponent).focusDiff('/src/bar.ts', fakeEvent);
    expect(focusedDiffFileSignal()).toBe('/src/bar.ts');
    expect(fakeEvent.stopPropagation).toHaveBeenCalled();
  });

  it('focusDiff() stops event propagation to avoid toggling the <details>', () => {
    fixture.componentRef.setInput('toolCall', makeTc({
      name: 'Edit',
      input: { file_path: '/x.ts' },
      diff: [{ path: 'x.ts', status: 'modified', lines: [] }],
    }));
    fixture.detectChanges();
    const fakeEvent = { stopPropagation: vi.fn() } as unknown as Event;
    childInstance(ToolDiffSectionComponent).focusDiff('/x.ts', fakeEvent);
    expect(fakeEvent.stopPropagation).toHaveBeenCalledOnce();
  });
});

describe('ToolCallCardComponent — sub-agent card (S-49)', () => {
  let fixture: ComponentFixture<ToolCallCardComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolCallCardComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: mockApi },
        { provide: AppStateService, useValue: mockState },
        { provide: ProjectAssetsService, useValue: mockAssets },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(ToolCallCardComponent);
  });

  const agent = (subagent: ToolCallRecord['subagent']) =>
    makeTc({ id: 'a1', name: 'Agent', input: { description: 'Read a.txt' }, subagent });
  const child = makeTc({ id: 'c1', name: 'Read', input: { file_path: '/p/a.txt' }, parentId: 'a1', result: 'alpha', isError: false });
  const html = () => (fixture.nativeElement as HTMLElement).innerHTML;

  it('is open while the sub-agent runs and folds when it completes', () => {
    fixture.componentRef.setInput('toolCall', agent({ status: 'running', description: 'Read a.txt' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(false);

    fixture.componentRef.setInput('toolCall', agent({ status: 'completed', description: 'Read a.txt', summary: 'alpha' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(true);
  });

  it('uses the robot icon for Agent and Task calls', () => {
    fixture.componentRef.setInput('toolCall', agent({ status: 'running' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.toolIconLucide()).toBe(LucideBot);
    fixture.componentRef.setInput('toolCall', makeTc({ id: 't2', name: 'Task' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.toolIconLucide()).toBe(LucideBot);
  });

  it('does not fold a card the user opened by hand', () => {
    fixture.componentRef.setInput('toolCall', agent({ status: 'running' }));
    fixture.detectChanges();
    fixture.componentInstance.toggleCollapsed(); // user closes
    fixture.componentInstance.toggleCollapsed(); // user opens again
    fixture.componentRef.setInput('toolCall', agent({ status: 'completed' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(false);
  });

  it('shows the task, the stats, the nested calls and the final report', () => {
    fixture.componentRef.setInput('toolCall', agent({
      status: 'completed', description: 'Read a.txt', subagentType: 'general-purpose',
      toolUses: 1, totalTokens: 18598, summary: 'the file says alpha',
    }));
    fixture.componentRef.setInput('children', [child]);
    fixture.detectChanges();
    expect(fixture.debugElement.queryAll(By.css('.tc-subagent-children ds-tool-call-card'))).toHaveLength(1);
    expect(html()).toContain('general-purpose');
    expect(html()).toContain('Read a.txt');
    expect(html()).toContain('the file says alpha');
  });

  it('keeps two parallel sub-agent cards independent', () => {
    const second = TestBed.createComponent(ToolCallCardComponent);
    fixture.componentRef.setInput('toolCall', agent({ status: 'running' }));
    second.componentRef.setInput('toolCall', { ...agent({ status: 'completed' }), id: 'a2' });
    fixture.detectChanges();
    second.detectChanges();
    expect(fixture.componentInstance.collapsed()).toBe(false);
    expect(second.componentInstance.collapsed()).toBe(true);
  });
});


describe('ToolCallCardComponent — run_script card (S-50)', () => {
  let fixture: ComponentFixture<ToolCallCardComponent>;
  const RUN = 'mcp__devia-code-mode__run_script';

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [ToolCallCardComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: mockApi },
        { provide: AppStateService, useValue: mockState },
        { provide: ProjectAssetsService, useValue: mockAssets },
      ],
    }).compileComponents();
    const translate = TestBed.inject(TranslateService);
    translate.setTranslation('en', {
      tool_card: {
        script_title: 'Script',
        script_line: '{{servers}} · {{calls}} calls · {{seconds}} s',
        script_line_running: '{{servers}} · {{calls}} calls so far',
        script_returned: 'Returned',
        script_calls: 'Calls',
        script_code: 'Code',
        script_savings: '≈{{tokens}} tokens of data stayed out of the context (estimate)',
        script_denied_note: '{{count}} denied',
        script_error_type: 'Type error: no tool was called',
        script_error_runtime: 'Script error',
        script_error_denied: 'Denied',
        script_error_other: 'Error',
        script_no_calls: 'No tool calls',
      },
    });
    translate.use('en');
    fixture = TestBed.createComponent(ToolCallCardComponent);
  });

  const script = (over: Partial<ToolCallRecord> = {}): ToolCallRecord =>
    makeTc({ id: 's1', name: RUN, input: { code: 'return 1;', description: 'Cross stores and sales' }, ...over });
  const call = (over: Partial<ToolCallRecord> = {}): ToolCallRecord =>
    makeTc({ id: 'c1', name: 'tiendas.listar', input: { region: 'norte' }, parentId: 's1', ...over });
  const okResult = (stats: Record<string, number> = {}): string =>
    JSON.stringify({ value: { top: 3 }, stats: { calls: 2, denied: 0, durationMs: 2300, bytesFetched: 400_000, bytesReturned: 2_000, ...stats } });
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const mount = (tc: ToolCallRecord, children: ToolCallRecord[] = [], active = true): void => {
    fixture.componentRef.setInput('toolCall', tc);
    fixture.componentRef.setInput('children', children);
    fixture.componentRef.setInput('active', active);
    fixture.detectChanges();
  };

  it('uses the code icon and a title of its own, with no MCP chip', () => {
    mount(script());
    expect(fixture.componentInstance.toolIconLucide()).toBe(LucideCodeXml);
    expect(el().querySelector('.tc-name')?.textContent).toContain('Script');
    expect(el().querySelector('.tc-mcp-chip')).toBeNull();
  });

  it('is open while the script runs and folds when it ends', () => {
    mount(script(), [call()]);
    expect(fixture.componentInstance.collapsed()).toBe(false);
    mount(script({ result: okResult() }), [call({ result: '120 bytes' })]);
    expect(fixture.componentInstance.collapsed()).toBe(true);
  });

  it('puts servers, calls and time in the one-line header once it ended', () => {
    mount(script({ result: okResult() }), [call({ result: '1 bytes' }), call({ id: 'c2', name: 'ventas.consultar', result: '2 bytes' })]);
    expect(el().querySelector('.tc-arg')?.textContent).toContain('tiendas, ventas · 2 calls · 2.3 s');
  });

  it('shows the calls so far while it runs', () => {
    mount(script(), [call()]);
    expect(el().querySelector('.tc-arg')?.textContent).toContain('tiendas · 1 calls so far');
  });

  it('shows what it returned, the nested calls and the code', () => {
    mount(script({ result: okResult() }), [call({ result: '120 bytes' }), call({ id: 'c2', name: 'ventas.consultar', result: '8 bytes' })]);
    expect(el().querySelector('.tc-script .tc-script-pre')?.textContent).toContain('"top": 3');
    expect(el().querySelectorAll('.tc-script-call')).toHaveLength(2);
    expect(el().querySelector('details.tc-script-code pre')?.textContent).toBe('return 1;');
    expect(el().textContent).toContain('Cross stores and sales');
  });

  it('marks a denied call apart from a failed one', () => {
    mount(script({ result: okResult({ denied: 1 }) }), [
      call({ id: 'a', isError: true, result: '[denied] not read-only' }),
      call({ id: 'b', isError: true, result: 'mcp down' }),
    ]);
    const states = Array.from(el().querySelectorAll('.tc-script-call')).map((li) => li.getAttribute('data-state'));
    expect(states).toEqual(['denied', 'error']);
  });

  it('says which of the three kinds of failure it was', () => {
    const kind = (tc: ToolCallRecord): string | null => {
      mount(tc);
      return el().querySelector('.tc-script-note')?.getAttribute('data-kind') ?? null;
    };
    expect(kind(script({ id: 's2', isError: true, result: 'The script does not type-check. No tool was called.\n1:8 Cannot find name x' }))).toBe('type_error');
    expect(kind(script({ id: 's3', isError: true, result: 'Script failed [runtime] (line 2): boom' }))).toBe('runtime_error');
    expect(kind(script({ id: 's4', isError: true, result: 'Script failed [runtime]: ToolDeniedError: nope' }))).toBe('denied');
  });

  it('shows the token saving only when it is worth saying', () => {
    mount(script({ result: okResult() }));
    expect(el().textContent).toContain('≈99.5k tokens of data stayed out of the context');
    mount(script({ id: 's5', result: okResult({ bytesFetched: 800, bytesReturned: 400 }) }));
    expect(el().textContent).not.toContain('stayed out of the context');
  });

  it('leaves every other tool card alone', () => {
    mount(makeTc({ id: 'x', name: 'Read', input: { file_path: '/p/a.txt' }, result: 'alpha' }));
    expect(el().querySelector('.tc-script')).toBeNull();
  });
});
