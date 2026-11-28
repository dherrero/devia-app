/**
 * S-56 T11 — a cross-agent worker talks in the chat: same side as the main
 * agent, avatar "A", a header with who/role/task/state, a cancel button while
 * it runs, and a collapsed body once it has finished.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { MessageBubbleComponent } from './message-bubble.component';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import type { ChatMessage } from '../../../../../../../shared/domain/chat';
import type { WorkerRun } from '../../../../../../../shared/domain/cross-agent';

const cancelWorker = vi.fn(() => Promise.resolve(true));
const mockApi: Partial<ElectronApiService> = {
  platform: 'linux',
  openPath: () => Promise.resolve(''),
  listSkills: () => Promise.resolve({ global: [], project: [] }),
  skillRegistryWatch: () => Promise.resolve(true),
  subAgentsList: () => Promise.resolve([]),
  mcpList: () => Promise.resolve([]),
  onSubAgentsChanged: () => () => undefined,
  onMcpListChanged: () => () => undefined,
  cancelWorker,
};

const run = (over: Partial<WorkerRun> = {}): WorkerRun => ({
  id: 'W-1',
  parentKey: 'proj-a',
  turnId: 't1',
  taskId: 'T-12',
  role: 'implementer',
  agentId: 'pi',
  runKey: 'devia-worker:proj-a:T-12:1',
  state: 'running',
  ...over,
});

const workerMessage = (worker: WorkerRun, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: 'm1', role: 'assistant', text: 'Working on it', streaming: worker.state === 'running', worker, ...over }) as ChatMessage;

describe('worker bubble (S-56 T11)', () => {
  let fixture: ComponentFixture<MessageBubbleComponent>;
  const el = (): HTMLElement => fixture.nativeElement as HTMLElement;
  const render = (msg: ChatMessage): void => {
    fixture.componentRef.setInput('msg', msg);
    fixture.detectChanges();
  };

  beforeEach(async () => {
    cancelWorker.mockClear();
    await TestBed.configureTestingModule({
      imports: [MessageBubbleComponent, TranslateModule.forRoot()],
      providers: [{ provide: ElectronApiService, useValue: mockApi }],
    }).compileComponents();
    fixture = TestBed.createComponent(MessageBubbleComponent);
  });

  it('draws the plain "A" avatar for a worker and keeps the Devia face for the main agent', () => {
    render(workerMessage(run()));
    expect(el().querySelector('.dv-chat-avatar__label')?.textContent?.trim()).toBe('A');
    expect(el().querySelector('.dv-chat-avatar__img')).toBeNull();

    fixture = TestBed.createComponent(MessageBubbleComponent);
    fixture.componentRef.setInput('msg', { id: 'm2', role: 'assistant', text: 'hi' } as ChatMessage);
    fixture.detectChanges();
    expect(el().querySelector('.dv-chat-avatar__label')).toBeNull();
    expect(el().querySelector('.dv-chat-avatar__img')).not.toBeNull();
  });

  it('shows who works on what: agent, role and task', () => {
    render(workerMessage(run()));
    const head = el().querySelector('.worker-head')?.textContent ?? '';
    expect(head).toContain('pi');
    expect(head).toContain('worker_bubble.role_implementer');
    expect(head).toContain('T-12');
  });

  it('shows the state, and the verdict once there is one', () => {
    render(workerMessage(run({ state: 'done', status: 'DONE' })));
    const head = el().querySelector('.worker-head')?.textContent ?? '';
    expect(head).toContain('worker_bubble.state_done');
    expect(head).toContain('DONE');
  });

  it('offers cancel while the worker is queued or running, and cancels exactly that worker', () => {
    render(workerMessage(run({ state: 'running' })));
    const button = el().querySelector('.worker-head dv-button[data-worker-cancel] button') as HTMLButtonElement;
    expect(button).not.toBeNull();
    button.click();
    expect(cancelWorker).toHaveBeenCalledWith('W-1');
  });

  it('offers no cancel once the worker is over', () => {
    render(workerMessage(run({ state: 'done', status: 'DONE' })));
    expect(el().querySelector('[data-worker-cancel]')).toBeNull();
  });

  it('keeps the body open while it runs and folds it once finished, with a toggle', () => {
    render(workerMessage(run({ state: 'running' })));
    expect(el().querySelector('.body-col')?.classList.contains('worker-collapsed')).toBe(false);

    fixture = TestBed.createComponent(MessageBubbleComponent);
    render(workerMessage(run({ state: 'done', status: 'DONE' }), { streaming: false }));
    const body = el().querySelector('.body-col') as HTMLElement;
    expect(body.classList.contains('worker-collapsed')).toBe(true);

    (el().querySelector('.worker-head dv-button[data-worker-toggle] button') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(body.classList.contains('worker-collapsed')).toBe(false);
  });

  it('shows how long it took once it is over', () => {
    render(workerMessage(run({ state: 'done', status: 'DONE', startedAt: 1_000, endedAt: 66_000 }), { streaming: false }));
    expect(el().querySelector('.worker-head')?.textContent).toContain('1m 05s');
  });

  it('a normal assistant message has no worker header', () => {
    render({ id: 'm3', role: 'assistant', text: 'hi' } as ChatMessage);
    expect(el().querySelector('.worker-head')).toBeNull();
  });
});
