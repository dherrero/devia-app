import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { TranslateModule } from '@ngx-translate/core';
import { MessagesFeedComponent } from './messages-feed.component';
import { ChatScrollService } from '../../services/chat-scroll.service';
import { AppStateService } from '../../../../../core/services/app-state.service';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import type { ChatMessage, ToolCallRecord } from '../../../../../../../shared/domain/chat';

// ChatScrollService is no longer providedIn:'root' — each ChatPanelComponent
// instance owns one. The feed spec creates MessagesFeedComponent in isolation,
// so we must supply the service at the module level here.

// MessageBubbleComponent is heavy; we don't need its rendering for the
// scaffolding tests. Use a NO_ERRORS_SCHEMA proxy by just trusting that
// Angular renders the host element — we assert on container classes and
// the empty-state, both of which are owned by the feed itself.

function makeMessage(over: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'm-1',
    role: 'user',
    text: 'hello',
    ...over,
  } as ChatMessage;
}

function makeQuestionTool(id: string): ToolCallRecord {
  return { id, name: 'AskUserQuestion', input: { question: 'Continuamos?' } };
}

describe('MessagesFeedComponent (HT-CH-03)', () => {
  let fixture: ComponentFixture<MessagesFeedComponent>;
  let scroll: ChatScrollService;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessagesFeedComponent, TranslateModule.forRoot()],
      providers: [
        ChatScrollService,
        { provide: AppStateService, useValue: {} },
        { provide: ElectronApiService, useValue: {} },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MessagesFeedComponent);
    scroll = TestBed.inject(ChatScrollService);
    fixture.componentRef.setInput('messages', []);
    fixture.componentRef.setInput('stream', null);
    fixture.detectChanges();
  });

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('renders the empty state when there are no messages and no stream', () => {
    const empty = el().querySelector('.ds-messages-feed__empty');
    expect(empty).not.toBeNull();
    expect(empty?.getAttribute('role')).toBe('status');
  });

  it('hides the empty state once a message is present', () => {
    fixture.componentRef.setInput('messages', [makeMessage()]);
    fixture.detectChanges();
    expect(el().querySelector('.ds-messages-feed__empty')).toBeNull();
  });

  it('hides the empty state when only a stream is in flight', () => {
    fixture.componentRef.setInput('stream', makeMessage({ id: 'stream', role: 'assistant' }));
    fixture.detectChanges();
    expect(el().querySelector('.ds-messages-feed__empty')).toBeNull();
  });

  it('registers its scroller with ChatScrollService on mount', () => {
    // The scroller is a div with the `.ds-messages-feed__scroll` class.
    const scroller = el().querySelector('.ds-messages-feed__scroll');
    expect(scroller).not.toBeNull();
    expect(scroll.container()).toBe(scroller);
  });

  it('unregisters the scroller when destroyed', () => {
    expect(scroll.container()).not.toBeNull();
    fixture.destroy();
    expect(scroll.container()).toBeNull();
  });

  // Full renderer chain for the error-bubble actions: a real system message
  // with errorClassification mounts the real MessageBubbleComponent →
  // DvErrorBubbleComponent, and a DOM click must surface through the feed's
  // outputs (the chat panel binds them to retryFromBubble/continueFromBubble).
  it('propagates continueRun from a clicked error-bubble continue action', () => {
    const spy = vi.fn();
    fixture.componentInstance.continueRun.subscribe(spy);
    fixture.componentRef.setInput('messages', [
      makeMessage({ role: 'system', errorClassification: 'crash', text: 'exit 1' }),
    ]);
    fixture.detectChanges();

    const btn = el().querySelector('.dv-error-continue') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('propagates retry from a clicked error-bubble retry action', () => {
    const spy = vi.fn();
    fixture.componentInstance.retry.subscribe(spy);
    fixture.componentRef.setInput('messages', [
      makeMessage({ role: 'system', errorClassification: 'crash', text: 'exit 1' }),
    ]);
    fixture.detectChanges();

    const btn = el().querySelector('.dv-error-retry') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn?.click();
    expect(spy).toHaveBeenCalledOnce();
  });

  it('renders a handoff divider (not a bubble) for kind:handoff and bubbles for the rest (S-2 F3.2)', () => {
    fixture.componentRef.setInput('messages', [
      makeMessage({ id: 'u1' }),
      makeMessage({
        id: 'h1',
        role: 'assistant',
        kind: 'handoff',
        handoff: { fromAgentId: 'codex', toAgentId: 'claude' },
        text: 'resumen',
      }),
    ]);
    fixture.detectChanges();

    expect(el().querySelectorAll('ds-handoff-divider')).toHaveLength(1);
    expect(el().querySelectorAll('ds-message-bubble')).toHaveLength(1);
  });

  it('activates avatar motion only for the latest visible assistant message', () => {
    fixture.componentRef.setInput('messages', [
      makeMessage({
        id: 'a1',
        role: 'assistant',
        toolCalls: [makeQuestionTool('q1')],
      }),
      makeMessage({
        id: 'a2',
        role: 'assistant',
        toolCalls: [makeQuestionTool('q2')],
      }),
    ]);
    fixture.detectChanges();

    const avatars = Array.from(el().querySelectorAll('dv-chat-avatar'));
    expect(avatars).toHaveLength(2);
    expect(avatars[0]?.getAttribute('data-active')).toBe('false');
    expect(avatars[0]?.getAttribute('data-state')).toBe('idle');
    expect(avatars[1]?.getAttribute('data-active')).toBe('true');
    expect(avatars[1]?.getAttribute('data-state')).toBe('asking');
  });
});
