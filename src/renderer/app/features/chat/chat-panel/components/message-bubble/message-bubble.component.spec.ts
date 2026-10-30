/**
 * UC-FIX-019 — Real Angular TestBed tests for MessageBubbleComponent.
 *
 * Tests focus on the deterministic computed signals:
 * usageLabel, hasThinking, agentLabel, htmlUsePlainText,
 * thinkingUsePlainText, statusIcon, showRetry.
 *
 * Note: DOMPurify and marked are not available in the jsdom test environment,
 * so renderedHtml() always falls back to plain-text (htmlUsePlainText() === true).
 * This is a valid test scenario covering the UC-FIX-016 fallback path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { TranslateModule } from '@ngx-translate/core';
import { MessageBubbleComponent } from './message-bubble.component';
import { AssistantTurnComponent } from './components/assistant-turn/assistant-turn.component';
import { ElectronApiService } from '../../../../../core/services/electron-api.service';
import type { ChatMessage, ToolCallRecord } from '../../../../../../../shared/domain/chat';
import { MarkdownRendererService } from '../../services/markdown-renderer.service';

// ── Minimal stubs ─────────────────────────────────────────────────────────

const mockApi: Partial<ElectronApiService> = {
  platform: 'linux',
  openPath: () => Promise.resolve(''),
  listSkills: () => Promise.resolve({ global: [], project: [] }),
  skillRegistryWatch: () => Promise.resolve(true),
  subAgentsList: () => Promise.resolve([]),
  mcpList: () => Promise.resolve([]),
  onSubAgentsChanged: () => () => undefined,
  onMcpListChanged: () => () => undefined,
};

function makeAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Date.now()}-0`,
    role: 'assistant',
    text: '',
    streaming: false,
    ...overrides,
  } as ChatMessage;
}

function makeSystem(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `msg-${Date.now()}-0`,
    role: 'system',
    text: 'An error occurred',
    ...overrides,
  } as ChatMessage;
}

function makeTool(id: string, name: string, result?: string, isError?: boolean): ToolCallRecord {
  const rec: ToolCallRecord = { id, name, input: { file_path: `/src/${id}.ts` } };
  // Omit optional fields rather than assigning undefined (exactOptionalPropertyTypes).
  if (result !== undefined) rec.result = result;
  if (isError !== undefined) rec.isError = isError;
  return rec;
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

// ── Setup ─────────────────────────────────────────────────────────────────

describe('MessageBubbleComponent — pure computeds', () => {
  let fixture: ComponentFixture<MessageBubbleComponent>;

  /** The assistant-case logic now lives in the ds-assistant-turn child;
   *  the parent only switches on role. Query the mounted child instance. */
  const assistantTurn = (): AssistantTurnComponent =>
    fixture.debugElement.query(By.directive(AssistantTurnComponent))
      .componentInstance as AssistantTurnComponent;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [MessageBubbleComponent, TranslateModule.forRoot()],
      providers: [
        { provide: ElectronApiService, useValue: mockApi },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MessageBubbleComponent);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // ── usageLabel ────────────────────────────────────────────────────────

  it('usageLabel() is null when usage is absent', () => {
    fixture.componentRef.setInput('msg', makeAssistant());
    fixture.detectChanges();
    expect(assistantTurn().usageLabel()).toBeNull();
  });

  it('usageLabel() formats tokens with cost', () => {
    fixture.componentRef.setInput('msg', makeAssistant({
      usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.005 },
    }));
    fixture.detectChanges();
    const label = assistantTurn().usageLabel();
    // toLocaleString format varies by locale (e.g. "1,000"); assert against
    // the locale-formatted values rather than a fixed digit string.
    expect(label).toContain((1000).toLocaleString());
    expect(label).toContain((200).toLocaleString());
    expect(label).toContain('$0.0050');
  });

  it('usageLabel() omits cost when costUsd is absent', () => {
    fixture.componentRef.setInput('msg', makeAssistant({
      usage: { inputTokens: 100, outputTokens: 50 },
    }));
    fixture.detectChanges();
    const label = assistantTurn().usageLabel();
    expect(label).not.toContain('$');
  });

  it('usageLabel() shows reasoning tokens when present', () => {
    fixture.componentRef.setInput('msg', makeAssistant({
      usage: { inputTokens: 100, outputTokens: 50, reasoningOutputTokens: 600 },
    }));
    fixture.detectChanges();
    const label = assistantTurn().usageLabel();
    expect(label).toContain('600');
    expect(label).toContain('🧠');
  });

  // ── hasThinking ───────────────────────────────────────────────────────

  it('hasThinking() is true for a non-empty thinking string', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ thinking: 'Deep thought…' }));
    fixture.detectChanges();
    expect(assistantTurn().hasThinking()).toBe(true);
  });

  it('hasThinking() is false for an empty string', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ thinking: '' }));
    fixture.detectChanges();
    expect(assistantTurn().hasThinking()).toBe(false);
  });

  it('hasThinking() is false when thinking is undefined', () => {
    fixture.componentRef.setInput('msg', makeAssistant());
    fixture.detectChanges();
    expect(assistantTurn().hasThinking()).toBe(false);
  });

  // ── agentLabel ────────────────────────────────────────────────────────

  it('agentLabel() joins agentId and model', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ agentId: 'claude', model: 'claude-sonnet-4-5' }));
    fixture.detectChanges();
    const label = assistantTurn().agentLabel();
    expect(label).toContain('claude');
    expect(label).toContain('claude-sonnet-4-5');
  });

  it('agentLabel() returns only agentId when model absent', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ agentId: 'codex' }));
    fixture.detectChanges();
    expect(assistantTurn().agentLabel()).toBe('codex');
  });

  it('agentLabel() returns null when both absent', () => {
    fixture.componentRef.setInput('msg', makeAssistant());
    fixture.detectChanges();
    expect(assistantTurn().agentLabel()).toBeNull();
  });

  // ── htmlUsePlainText (UC-FIX-016) ─────────────────────────────────────

  it('htmlUsePlainText() is true in jsdom (DOMPurify not available)', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ text: 'hello' }));
    fixture.detectChanges();
    // DOMPurify is not loaded in the jsdom test environment, so the
    // safe fallback path is always active — this is the UC-FIX-016 path.
    expect(assistantTurn().htmlUsePlainText()).toBe(true);
  });

  // ── statusIcon ────────────────────────────────────────────────────────

  it('statusIcon() is null for runStatus succeeded', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ runStatus: 'succeeded' }));
    fixture.detectChanges();
    expect(assistantTurn().statusIcon()).toBeNull();
  });

  it('statusIcon() is "warning" for runStatus failed', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ runStatus: 'failed' }));
    fixture.detectChanges();
    expect(assistantTurn().statusIcon()).toBe('warning');
  });

  it('statusIcon() is "cancel" for runStatus canceled', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ runStatus: 'canceled' }));
    fixture.detectChanges();
    expect(assistantTurn().statusIcon()).toBe('cancel');
  });

  describe('question tool records', () => {
    const ASK = 'mcp__devia-ui__devia_ask_user';
    const questionTurn = (result: string | undefined, runStatus: ChatMessage['runStatus']) =>
      makeAssistant({
        ...(runStatus !== undefined && { runStatus }),
        toolCalls: [makeTool('t-ask', ASK, result)],
        contentBlocks: [{ kind: 'tool_ref', toolCallId: 't-ask' }],
      });
    const kinds = () => (assistantTurn().renderedContentBlocks() ?? []).map((b) => b.kind);

    it('hides a pending devia_ask_user while its run is live', () => {
      fixture.componentRef.setInput('msg', questionTurn(undefined, 'running'));
      fixture.detectChanges();
      expect(kinds()).toEqual([]);
    });

    it('renders an answered devia_ask_user as a question record, never as a tool card', () => {
      for (const name of [ASK, 'AskUserQuestion', 'devia-ui_devia_ask_user']) {
        fixture.componentRef.setInput('msg', makeAssistant({
          runStatus: 'succeeded',
          toolCalls: [makeTool('t-ask', name, 'Verde')],
          contentBlocks: [{ kind: 'tool_ref', toolCallId: 't-ask' }],
        }));
        fixture.detectChanges();
        expect(kinds()).toEqual(['question']);
      }
      expect(fixture.nativeElement.querySelector('ds-question-answered-card')).not.toBeNull();
    });

    it('keeps the question of a finished run whose answer was never recorded', () => {
      fixture.componentRef.setInput('msg', questionTurn(undefined, 'succeeded'));
      fixture.detectChanges();
      expect(kinds()).toEqual(['question']);
    });

    it('drops a question that errored (timeout / denial)', () => {
      fixture.componentRef.setInput('msg', makeAssistant({
        runStatus: 'succeeded',
        toolCalls: [makeTool('t-ask', ASK, 'timeout', true)],
        contentBlocks: [{ kind: 'tool_ref', toolCallId: 't-ask' }],
      }));
      fixture.detectChanges();
      expect(kinds()).toEqual([]);
    });
  });

  describe('avatarState()', () => {
    it('maps live tool categories to the 15-state avatar contract', () => {
      const cases: Array<[ReturnType<typeof makeTool>, string]> = [
        [makeTool('t-read', 'Read'), 'searching'],
        [makeTool('t-write', 'Write'), 'writing'],
        [makeTool('t-bash', 'Bash'), 'terminal'],
        [makeTool('t-plan', 'TodoWrite'), 'planning'],
        [makeTool('t-mcp', 'mcp__server__call'), 'tool'],
      ];

      for (const [tc, expected] of cases) {
        fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [tc] }));
        fixture.detectChanges();
        expect(assistantTurn().avatarState()).toBe(expected);
      }
    });

    it('uses asking for pending AskUserQuestion calls', () => {
      fixture.componentRef.setInput('msg', makeAssistant({
        toolCalls: [makeTool('t-question', 'AskUserQuestion')],
      }));
      fixture.detectChanges();
      expect(assistantTurn().avatarState()).toBe('asking');
    });

    it('forces history assistant avatars to idle when they are not the latest bubble', () => {
      fixture.componentRef.setInput('msg', makeAssistant({
        toolCalls: [makeTool('t-question', 'AskUserQuestion')],
      }));
      fixture.componentRef.setInput('isLatest', false);
      fixture.detectChanges();

      expect(assistantTurn().avatarState()).toBe('idle');
      const avatar = (fixture.nativeElement as HTMLElement).querySelector('dv-chat-avatar');
      expect(avatar?.getAttribute('data-state')).toBe('idle');
      expect(avatar?.getAttribute('data-active')).toBe('false');
    });

    it('uses streaming for live text, success after a watched completion, and paused when canceled', () => {
      fixture.componentRef.setInput('msg', makeAssistant({
        streaming: true,
        contentBlocks: [{ kind: 'text', text: 'hola' }],
      }));
      fixture.detectChanges();
      expect(assistantTurn().avatarState()).toBe('streaming');

      fixture.componentRef.setInput('msg', makeAssistant({ streaming: false, runStatus: 'succeeded' }));
      fixture.detectChanges();
      expect(assistantTurn().avatarState()).toBe('success');

      fixture.componentRef.setInput('msg', makeAssistant({ runStatus: 'canceled' }));
      fixture.detectChanges();
      expect(assistantTurn().avatarState()).toBe('paused');
    });

    it('uses error for failed runs and warning for non-fatal tool errors', () => {
      fixture.componentRef.setInput('msg', makeAssistant({ runStatus: 'failed' }));
      fixture.detectChanges();
      expect(assistantTurn().avatarState()).toBe('error');

      fixture.componentRef.setInput('msg', makeAssistant({
        toolCalls: [makeTool('t-warning', 'Read', 'boom', true)],
      }));
      fixture.detectChanges();
      expect(assistantTurn().avatarState()).toBe('warning');
    });

  });

  // ── showRetry ─────────────────────────────────────────────────────────

  it('showRetry() is false when cancelReason is "user"', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ cancelReason: 'user' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.showRetry()).toBe(false);
  });

  it('showRetry() is true for question_timeout cancelReason', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ cancelReason: 'question_timeout' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.showRetry()).toBe(true);
  });

  // ── DOM assertion ─────────────────────────────────────────────────────

  it('.usage-line is rendered when usage is set', () => {
    fixture.componentRef.setInput('msg', makeAssistant({
      usage: { inputTokens: 10, outputTokens: 5 },
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.usage-line')).not.toBeNull();
  });

  it('.usage-line is absent when usage is null', () => {
    fixture.componentRef.setInput('msg', makeAssistant());
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.usage-line')).toBeNull();
  });

  describe('isToolInFlight — only the last unfinished tool is "running"', () => {
    const tc = (over: Partial<ToolCallRecord>): ToolCallRecord =>
      ({ id: 'x', name: 'Bash', input: {}, ...over }) as ToolCallRecord;

    it('marks only the last unfinished tool while streaming', () => {
      const first = tc({ id: 't1', name: 'Read', result: 'done' });
      const last = tc({ id: 't2', name: 'Bash' }); // result undefined → running
      fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [first, last] }));
      fixture.detectChanges();
      const c = assistantTurn();
      expect(c.isToolInFlight(first)).toBe(false);
      expect(c.isToolInFlight(last)).toBe(true);
    });

    it('treats an unfinished earlier tool as settled, not in-flight', () => {
      // Results haven't been back-filled yet, but only the last is live.
      const first = tc({ id: 't1' });
      const last = tc({ id: 't2' });
      fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [first, last] }));
      fixture.detectChanges();
      expect(assistantTurn().isToolInFlight(first)).toBe(false);
      expect(assistantTurn().isToolInFlight(last)).toBe(true);
    });

    it('marks nothing in-flight once streaming ends', () => {
      const only = tc({ id: 't1' });
      fixture.componentRef.setInput('msg', makeAssistant({ streaming: false, toolCalls: [only] }));
      fixture.detectChanges();
      expect(assistantTurn().isToolInFlight(only)).toBe(false);
    });

    it('marks nothing in-flight when the last tool already finished', () => {
      const a = tc({ id: 't1', result: 'a' });
      const b = tc({ id: 't2', result: 'b' });
      fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [a, b] }));
      fixture.detectChanges();
      const c = assistantTurn();
      expect(c.isToolInFlight(a)).toBe(false);
      expect(c.isToolInFlight(b)).toBe(false);
    });
  });

  it('<details class="thinking-block"> renders when thinking is set', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ thinking: 'I am thinking…' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('details.thinking-block')).not.toBeNull();
  });

  // ── Improvement #1: streaming progress line ────────────────────────────

  it('shows .progress-line when streaming=true and there is an in-flight tool call', () => {
    const tc = makeTool('t1', 'Read'); // result=undefined → in-flight
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: true,
      toolCalls: [tc],
      contentBlocks: [{ kind: 'tool_ref', toolCallId: 't1' }],
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.progress-line')).not.toBeNull();
  });

  it('shows .progress-line when streaming=true with no in-flight tool (generic label)', () => {
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: true,
      text: 'writing...',
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.progress-line')).not.toBeNull();
  });

  it('hides .progress-line when streaming=false', () => {
    const tc = makeTool('t1', 'Read', 'some result'); // result present → done
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: false,
      toolCalls: [tc],
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.progress-line')).toBeNull();
  });

  it('progressLabel() uses tool_summary key when an in-flight tool exists', () => {
    const tc = makeTool('t1', 'Read'); // result=undefined → running
    fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [tc] }));
    fixture.detectChanges();
    // In jsdom with no i18n loaded, instant() returns the key itself.
    const label = assistantTurn().progressLabel();
    expect(label).toBe('tool_summary.reading');
  });

  it('progressLabel() falls back to bubble_progress.thinking when no in-flight tool', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [] }));
    fixture.detectChanges();
    const label = assistantTurn().progressLabel();
    expect(label).toBe('bubble_progress.thinking');
  });

  it('progressArg() returns the file_path from the in-flight tool input', () => {
    const tc: ToolCallRecord = { id: 't1', name: 'Read', input: { file_path: '/src/app.ts' } };
    fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [tc] }));
    fixture.detectChanges();
    expect(assistantTurn().progressArg()).toBe('/src/app.ts');
  });

  it('progressArg() returns empty string when no in-flight tool', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ streaming: true, toolCalls: [] }));
    fixture.detectChanges();
    expect(assistantTurn().progressArg()).toBe('');
  });

  // ── Improvement #2: tool-call grouping ────────────────────────────────

  it('displayBlocks() returns null when no contentBlocks (legacy fallback)', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ text: 'hello' }));
    fixture.detectChanges();
    expect(assistantTurn().displayBlocks()).toBeNull();
  });

  it('displayBlocks() does NOT group a run of 2 consecutive tool_ref blocks', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    fixture.componentRef.setInput('msg', makeAssistant({
      toolCalls: [tc1, tc2],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
      ],
    }));
    fixture.detectChanges();
    const blocks = assistantTurn().displayBlocks() ?? [];
    expect(blocks.every(b => b.kind === 'tool_ref')).toBe(true);
    expect(blocks).toHaveLength(2);
  });

  it('displayBlocks() groups a run of 3 consecutive tool_ref blocks into a tool_group', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    const tc3 = makeTool('t3', 'Write', 'done');
    fixture.componentRef.setInput('msg', makeAssistant({
      toolCalls: [tc1, tc2, tc3],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
      ],
    }));
    fixture.detectChanges();
    const blocks = expectPresent(assistantTurn().displayBlocks());
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool_group');
  });

  it('displayBlocks() groups 3+ but keeps isolated tool_ref below threshold separate', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    const tc3 = makeTool('t3', 'Write', 'done');
    const tc4 = makeTool('t4', 'Bash', 'done');
    fixture.componentRef.setInput('msg', makeAssistant({
      toolCalls: [tc1, tc2, tc3, tc4],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
        { kind: 'tool_ref', toolCallId: 't4' },
      ],
    }));
    fixture.detectChanges();
    const blocks = expectPresent(assistantTurn().displayBlocks());
    // All 4 are consecutive → one group.
    expect(blocks).toHaveLength(1);
    expect(blocks[0].kind).toBe('tool_group');
  });

  it('displayBlocks() does not group tool_ref runs broken by a text block', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    const tc3 = makeTool('t3', 'Write', 'done');
    fixture.componentRef.setInput('msg', makeAssistant({
      toolCalls: [tc1, tc2, tc3],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'text', text: 'Intermediate text' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
      ],
    }));
    fixture.detectChanges();
    const blocks = expectPresent(assistantTurn().displayBlocks());
    // Run of 1, text, run of 2 — no group qualifies.
    expect(blocks.some(b => b.kind === 'tool_group')).toBe(false);
  });

  it('tool_group hasInFlight is true when a streaming message has a member with result===undefined', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    const tc3 = makeTool('t3', 'Write'); // result=undefined → in-flight
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: true,
      toolCalls: [tc1, tc2, tc3],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
      ],
    }));
    fixture.detectChanges();
    const blocks = expectPresent(assistantTurn().displayBlocks());
    const group = blocks[0] as { kind: 'tool_group'; hasInFlight: boolean };
    expect(group.kind).toBe('tool_group');
    expect(group.hasInFlight).toBe(true);
  });

  it('tool_group hasInFlight is false after streaming ends even if a result is missing', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    const tc3 = makeTool('t3', 'Write');
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: false,
      toolCalls: [tc1, tc2, tc3],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
      ],
    }));
    fixture.detectChanges();
    const blocks = expectPresent(assistantTurn().displayBlocks());
    const group = blocks[0] as { kind: 'tool_group'; hasInFlight: boolean };
    expect(group.kind).toBe('tool_group');
    expect(group.hasInFlight).toBe(false);
  });

  it('tool_group hasError is true when a member has isError=true', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'err', true);
    const tc3 = makeTool('t3', 'Write', 'done');
    fixture.componentRef.setInput('msg', makeAssistant({
      toolCalls: [tc1, tc2, tc3],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
      ],
    }));
    fixture.detectChanges();
    const blocks = expectPresent(assistantTurn().displayBlocks());
    const group = blocks[0] as { kind: 'tool_group'; hasError: boolean };
    expect(group.kind).toBe('tool_group');
    expect(group.hasError).toBe(true);
  });

  it('DOM: renders <details class="tool-group"> for a group of 3 tool_ref blocks', () => {
    const tc1 = makeTool('t1', 'Read', 'done');
    const tc2 = makeTool('t2', 'Edit', 'done');
    const tc3 = makeTool('t3', 'Write', 'done');
    fixture.componentRef.setInput('msg', makeAssistant({
      toolCalls: [tc1, tc2, tc3],
      contentBlocks: [
        { kind: 'tool_ref', toolCallId: 't1' },
        { kind: 'tool_ref', toolCallId: 't2' },
        { kind: 'tool_ref', toolCallId: 't3' },
      ],
    }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('details.tool-group')).not.toBeNull();
  });

  it('streams the agent text live and formatted while running', () => {
    const markdown = TestBed.inject(MarkdownRendererService);
    const renderSpy = vi.spyOn(markdown, 'render');

    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: true,
      contentBlocks: [{ kind: 'text', text: '**streaming**' }],
    }));
    fixture.detectChanges();

    // The growing block is rendered live (markdown), not deferred to the end.
    expect(renderSpy).toHaveBeenCalledWith(expect.stringContaining(':block:0'), '**streaming**');
    const el = fixture.nativeElement as HTMLElement;
    // The text is visible during the stream (jsdom lacks marked/DOMPurify, so it
    // falls back to the plain-text branch — the real app shows .md-content).
    expect(el.querySelector('.message-segment')).not.toBeNull();
    expect(el.textContent).toContain('**streaming**');
  });

  it('shows interleaved text and tool cards live while streaming', () => {
    const tc = makeTool('tc-1', 'Read');
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: true,
      toolCalls: [tc],
      contentBlocks: [
        { kind: 'text', text: 'intro' },
        { kind: 'tool_ref', toolCallId: 'tc-1' },
        { kind: 'text', text: 'tail' },
      ],
    }));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    // Both text segments and the tool card are visible at once, mid-stream.
    expect(el.querySelectorAll('.message-segment')).toHaveLength(2);
    expect(el.querySelector('ds-tool-call-card')).not.toBeNull();
    expect(el.textContent).toContain('intro');
    expect(el.textContent).toContain('tail');
  });

  it('flips justCompleted only after watching the message finish streaming', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ streaming: true }));
    fixture.detectChanges();
    expect(assistantTurn().justCompleted()).toBe(false);

    fixture.componentRef.setInput('msg', makeAssistant({ streaming: false }));
    fixture.detectChanges();
    expect(assistantTurn().justCompleted()).toBe(true);
  });

  it('does not flip justCompleted for an already-done history message', () => {
    fixture.componentRef.setInput('msg', makeAssistant({ streaming: false }));
    fixture.detectChanges();
    expect(assistantTurn().justCompleted()).toBe(false);
  });

  it('does not open chat-bubble tooltips from assistant messages or copy buttons', () => {
    vi.useFakeTimers();
    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: false,
      contentBlocks: [{ kind: 'text', text: 'done' }],
    }));
    fixture.detectChanges();

    const el = fixture.nativeElement as HTMLElement;
    el.querySelector('.msg-asst')?.dispatchEvent(new MouseEvent('mouseenter'));
    el.querySelector('.copy-btn-slot dv-button')?.dispatchEvent(new MouseEvent('mouseenter'));
    vi.advanceTimersByTime(350);
    fixture.detectChanges();

    expect(document.querySelector('.dv-tooltip-panel')).toBeNull();
  });

  it('renders markdown for finalized text blocks', () => {
    const markdown = TestBed.inject(MarkdownRendererService);
    const renderSpy = vi.spyOn(markdown, 'render');
    const prewarmSpy = vi.spyOn(markdown, 'prewarm');

    fixture.componentRef.setInput('msg', makeAssistant({
      streaming: false,
      contentBlocks: [{ kind: 'text', text: '**done**' }],
    }));
    fixture.detectChanges();

    expect(renderSpy).toHaveBeenCalledWith(expect.stringContaining(':block:0'), '**done**');
    expect(prewarmSpy).not.toHaveBeenCalled();
  });

  // ── Improvement #3: classified error card ─────────────────────────────

  it('errorCardData() returns null for a system message without errorClassification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ cancelReason: 'idle' }));
    fixture.detectChanges();
    expect(fixture.componentInstance.errorCardData()).toBeNull();
  });

  it('errorCardData() returns a record with titleKey for auth classification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'auth' }));
    fixture.detectChanges();
    const data = fixture.componentInstance.errorCardData();
    expect(expectPresent(data).titleKey).toBe('error_card.auth');
  });

  it('errorCardData() returns a record with titleKey for prompt-too-large classification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'prompt-too-large' }));
    fixture.detectChanges();
    const data = fixture.componentInstance.errorCardData();
    expect(expectPresent(data).titleKey).toBe('error_card.prompt_too_large');
  });

  it('errorCardData() returns a record with titleKey for transient classification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'transient' }));
    fixture.detectChanges();
    expect(expectPresent(fixture.componentInstance.errorCardData()).titleKey).toBe('error_card.transient');
  });

  it('errorCardData() returns a record with titleKey for crash classification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'crash' }));
    fixture.detectChanges();
    expect(expectPresent(fixture.componentInstance.errorCardData()).titleKey).toBe('error_card.crash');
  });

  it('errorCardData() returns a record with titleKey for unknown classification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'unknown' }));
    fixture.detectChanges();
    expect(expectPresent(fixture.componentInstance.errorCardData()).titleKey).toBe('error_card.unknown');
  });

  it('DOM: renders .msg-error-card instead of .msg-sys for auth errorClassification', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'auth' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.msg-error-card')).not.toBeNull();
    expect(el.querySelector('.msg-sys')).toBeNull();
  });

  it('DOM: renders .msg-sys (divider) when no errorClassification', () => {
    fixture.componentRef.setInput('msg', makeSystem());
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.msg-sys')).not.toBeNull();
    expect(el.querySelector('.msg-error-card')).toBeNull();
  });

  it('DOM: error card shows a retry action when showRetry() is true (auth + no cancelReason)', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'auth' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    // showRetry is true because errorClassification is present and cancelReason is not 'user'
    expect(fixture.componentInstance.showRetry()).toBe(true);
    expect(el.querySelector('.msg-error-card .dv-error-retry')).not.toBeNull();
  });

  it('DOM: error card does NOT show a retry action when cancelReason=user', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'auth', cancelReason: 'user' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(fixture.componentInstance.showRetry()).toBe(false);
    // The error card itself is shown but without the retry button.
    expect(el.querySelector('.msg-error-card')).not.toBeNull();
    expect(el.querySelector('.msg-error-card .dv-error-retry')).toBeNull();
  });

  it('DOM: error card shows a continue action when showRetry() is true', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'transient' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.msg-error-card .dv-error-continue')).not.toBeNull();
  });

  it('DOM: error card does NOT show a continue action when cancelReason=user', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'auth', cancelReason: 'user' }));
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.msg-error-card .dv-error-continue')).toBeNull();
  });

  it('DOM: clicking continue on the error card emits continueRun', () => {
    fixture.componentRef.setInput('msg', makeSystem({ errorClassification: 'crash' }));
    const spy = vi.fn();
    fixture.componentInstance.continueRun.subscribe(spy);
    fixture.detectChanges();
    const btn = (fixture.nativeElement as HTMLElement).querySelector(
      '.msg-error-card .dv-error-continue',
    ) as HTMLButtonElement;
    btn.click();
    expect(spy).toHaveBeenCalledOnce();
  });
});
