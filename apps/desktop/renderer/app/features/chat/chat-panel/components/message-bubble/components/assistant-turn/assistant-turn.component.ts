import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import {
  ButtonComponent,
  DvAiBubbleComponent,
  IconComponent,
  type DvChatAvatarState,
} from '@devia/ui';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import {
  LucideLoader, LucideCheck, LucideCopy,
  LucideBrain, LucideLayers,
} from '@lucide/angular';
import type { ToolCallRecord } from '../../../../../../../../../shared/domain/chat';
import { summarizeToolCall } from '../../../../../../../../../shared/domain/tool-summary';
import { isAskUserTool } from '../../../../../../../../../shared/domain/question-ask';
import { ToolCallCardComponent } from '../../../tool-call-card/tool-call-card.component';
import { QuestionAnsweredCardComponent } from '../../../question-answered-card/question-answered-card.component';
import type { ChatBubbleMessage } from '../../../../models/chat-bubble-contract.model';
import { MarkdownRendererService } from '../../../../services/markdown-renderer.service';
import { TypewriterDirective } from '../../../../directives/typewriter/typewriter.directive';
import { toolArg } from '../../utils/message-bubble.utils';

/** Pre-processed content block used by the template — computed once per CD. */
type RenderedBlock =
  | { kind: 'text'; raw: string; html: SafeHtml | null; plainTextFallback: boolean }
  | { kind: 'tool_ref'; toolCall: ToolCallRecord | null }
  | { kind: 'question'; toolCall: ToolCallRecord };

/** A group of ≥3 consecutive tool_ref blocks collapsed into a <details>. */
type ToolGroup = {
  kind: 'tool_group';
  toolCalls: ToolCallRecord[];
  /** True when at least one member has result===undefined while the message is still streaming. */
  hasInFlight: boolean;
  /** True when at least one member has isError===true. */
  hasError: boolean;
  fileCount: number;
  cmdCount: number;
  otherCount: number;
};

/** Final display item after grouping. */
type DisplayBlock = RenderedBlock | ToolGroup;

declare const DOMPurify: { sanitize(html: string): string };

const FILE_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookRead', 'NotebookEdit']);
const CMD_TOOLS  = new Set(['Bash', 'Execute']);
const AVATAR_PLAN_TOOLS = new Set([
  'Plan',
  'EnterPlanMode',
  'ExitPlanMode',
  'TodoWrite',
  'TaskCreate',
  'TaskUpdate',
  'TaskList',
  'TaskGet',
  'TaskStop',
  'TaskOutput',
]);
const AVATAR_SEARCH_TOOLS = new Set(['Read', 'NotebookRead', 'Grep', 'Glob', 'WebFetch', 'WebSearch']);
const AVATAR_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'file_change']);
const AVATAR_TERMINAL_TOOLS = new Set(['Bash', 'Execute']);

/** Minimum consecutive tool_ref blocks to collapse into a group. */
const GROUP_THRESHOLD = 3;

function avatarStateForToolCall(tc: ToolCallRecord): DvChatAvatarState {
  const name = tc.name;
  if (isAskUserTool(name)) return 'asking';
  if (AVATAR_PLAN_TOOLS.has(name)) return 'planning';
  if (AVATAR_SEARCH_TOOLS.has(name)) return 'searching';
  if (AVATAR_WRITE_TOOLS.has(name)) return 'writing';
  if (AVATAR_TERMINAL_TOOLS.has(name)) return 'terminal';
  return 'tool';
}

/** An AskUserQuestion the user actually answered (timeouts/denials excluded). */
function isAnsweredQuestion(tc: ToolCallRecord): boolean {
  return typeof tc.result === 'string' && tc.result.trim().length > 0 && tc.isError !== true;
}

/**
 * Answered questions always render as a record. One with no result renders too
 * once its run is over: Claude never streams tool results back, so sessions
 * saved before the answer was recorded on the right tool call still show what
 * was asked. While the run is live the interactive card owns it.
 */
function showsQuestionRecord(tc: ToolCallRecord, runStatus: string | undefined): boolean {
  if (tc.isError === true) return false;
  return isAnsweredQuestion(tc) || (runStatus !== 'running' && tc.result === undefined);
}

@Component({
  selector: 'ds-assistant-turn',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    DvAiBubbleComponent,
    IconComponent,
    TranslateModule,
    ToolCallCardComponent,
    QuestionAnsweredCardComponent,
    TypewriterDirective,
  ],
  templateUrl: './assistant-turn.component.html',
  styleUrl: './assistant-turn.component.scss',
})
export class AssistantTurnComponent {
  readonly LucideLoader = LucideLoader;
  readonly LucideCheck = LucideCheck;
  readonly LucideCopy = LucideCopy;
  readonly LucideBrain = LucideBrain;
  readonly LucideLayers = LucideLayers;
  private readonly sanitizer = inject(DomSanitizer);
  private readonly translate = inject(TranslateService);
  private readonly markdown = inject(MarkdownRendererService);

  readonly msg = input.required<ChatBubbleMessage>();
  readonly isLatest = input(true);

  /** Flips to `true` once this bubble watches its message finish streaming, so
   *  the just-completed reply types itself in (see TypewriterDirective). History
   *  messages mount already-done and never transition, so they render instantly. */
  readonly justCompleted = signal(false);
  private wasStreaming = false;

  constructor() {
    effect(() => {
      const streaming = this.msg().streaming === true;
      if (this.wasStreaming && !streaming) this.justCompleted.set(true);
      this.wasStreaming = streaming;
    });
  }

  private readonly _renderedLegacyMarkdown = computed(() => {
    const msg = this.msg();
    return this.markdown.render(this.markdownKey('legacy'), msg.text ?? '');
  });

  /** True when DOMPurify is absent or threw — template uses plain-text interpolation. */
  readonly htmlUsePlainText = computed(() => this._renderedLegacyMarkdown().plainTextFallback);

  readonly renderedHtml = computed<SafeHtml>(() =>
    this._renderedLegacyMarkdown().html,
  );

  /**
   * Pre-processes all content blocks once per signal change (OnPush-safe).
   * Returns null when there are no blocks, triggering the legacy fallback.
   * Each text block is rendered to SafeHtml here so the template never calls
   * marked.parse() or DOMPurify.sanitize() per-block on every CD cycle.
   */
  readonly renderedContentBlocks = computed<RenderedBlock[] | null>(() => {
    const msg = this.msg();
    const blocks = msg.contentBlocks;
    if (!blocks?.length) return null;
    const toolMap = new Map<string, ToolCallRecord>();
    for (const tc of msg.toolCalls ?? []) toolMap.set(tc.id, tc);
    return blocks.map((block, index): RenderedBlock | null => {
      if (block.kind === 'text') {
        // Render markdown live, including the still-growing last block while the
        // run streams, so the agent's prose appears formatted as it arrives
        // (interleaved with tool cards) instead of popping in all at once at the
        // end. The render cache keys on the block text, so a frame that didn't
        // grow the block is a cache hit.
        const key = this.markdownKey(`block:${index}`);
        const rendered = this.markdown.render(key, block.text);
        return {
          kind: 'text' as const,
          raw: block.text,
          html: rendered.html,
          plainTextFallback: rendered.plainTextFallback,
        };
      }
      const toolCall = toolMap.get(block.toolCallId) ?? null;
      // A question tool never renders as a tool card. While pending, the
      // interactive question card at the bottom of the feed owns it (so it is
      // dropped here); once answered, it stays in the transcript as a
      // read-only question+answer record.
      if (toolCall && isAskUserTool(toolCall.name)) {
        return showsQuestionRecord(toolCall, msg.runStatus)
          ? { kind: 'question' as const, toolCall }
          : null;
      }
      return { kind: 'tool_ref' as const, toolCall };
    })
    .filter((rb): rb is RenderedBlock => rb !== null);
  });

  /** Legacy flat tool-calls with AskUserQuestion stripped (it renders as a
   *  question record, never as a tool card). */
  readonly legacyToolCalls = computed<ToolCallRecord[]>(() =>
    (this.msg().toolCalls ?? []).filter((tc) => !isAskUserTool(tc.name)),
  );

  /** Answered AskUserQuestion calls for the legacy (no contentBlocks) path. */
  readonly legacyAnsweredQuestions = computed<ToolCallRecord[]>(() =>
    (this.msg().toolCalls ?? []).filter(
      (tc) => isAskUserTool(tc.name) && showsQuestionRecord(tc, this.msg().runStatus),
    ),
  );

  /**
   * Improvement #2: transforms renderedContentBlocks into DisplayBlock[], grouping
   * runs of ≥GROUP_THRESHOLD consecutive tool_ref blocks into a ToolGroup.
   * Returns null when there are no content blocks (triggers legacy fallback).
   */
  readonly displayBlocks = computed<DisplayBlock[] | null>(() => {
    const raw = this.renderedContentBlocks();
    if (!raw) return null;

    const result: DisplayBlock[] = [];
    let i = 0;

    while (i < raw.length) {
      const block = raw[i];

      if (block.kind !== 'tool_ref') {
        result.push(block);
        i++;
        continue;
      }

      // Count the run of consecutive tool_ref blocks from position i.
      let j = i;
      while (j < raw.length && raw[j].kind === 'tool_ref') j++;
      const runLen = j - i;

      if (runLen < GROUP_THRESHOLD) {
        // Less than threshold — emit as individual cards.
        for (let k = i; k < j; k++) result.push(raw[k]);
      } else {
        // Collect ToolCallRecord objects for this run.
        const toolCalls: ToolCallRecord[] = [];
        let hasInFlight = false;
        let hasError = false;
        let fileCount = 0;
        let cmdCount = 0;
        let otherCount = 0;

        for (let k = i; k < j; k++) {
          const ref = raw[k] as { kind: 'tool_ref'; toolCall: ToolCallRecord | null };
          if (!ref.toolCall) continue;
          const tc = ref.toolCall;
          toolCalls.push(tc);
          if (this.msg().streaming && tc.result === undefined && !tc.isError) hasInFlight = true;
          if (tc.isError) hasError = true;
          if (FILE_TOOLS.has(tc.name)) fileCount++;
          else if (CMD_TOOLS.has(tc.name)) cmdCount++;
          else otherCount++;
        }

        result.push({ kind: 'tool_group', toolCalls, hasInFlight, hasError, fileCount, cmdCount, otherCount });
      }

      i = j;
    }

    return result;
  });

  /** Track function for the @for loop over displayBlocks. */
  trackBlock(index: number, block: DisplayBlock): string {
    if (block.kind === 'text') return `text-${index}`;
    if (block.kind === 'question') return `question-${block.toolCall.id}`;
    if (block.kind === 'tool_ref') return `tool-${block.toolCall?.id ?? index}`;
    // tool_group: use the id of the first tool call as a stable key.
    return `group-${block.toolCalls[0]?.id ?? index}`;
  }

  private markdownKey(segment: string): string {
    return this.markdownKeyFor(this.msg().id, segment);
  }

  private markdownKeyFor(messageId: string, segment: string): string {
    return `${messageId}:${segment}`;
  }

  /** Builds the summary label for a tool group. */
  groupLabel(group: ToolGroup): string {
    const parts: string[] = [];
    const total = group.fileCount + group.cmdCount + group.otherCount;

    if (group.fileCount > 0) {
      parts.push(this.translate.instant('tool_group.files', { count: group.fileCount }));
    }
    if (group.cmdCount > 0) {
      parts.push(this.translate.instant('tool_group.commands', { count: group.cmdCount }));
    }
    if (group.otherCount > 0) {
      parts.push(this.translate.instant('tool_group.actions', { count: group.otherCount }));
    }

    const itemsSummary = parts.join(' · ');
    return this.translate.instant('tool_group.summary', { summary: itemsSummary, total });
  }

  /**
   * Improvement #1: the in-flight tool call (result===undefined, !isError).
   * Used to derive the progress label below.
   */
  private readonly inFlightToolCall = computed<ToolCallRecord | null>(() => {
    const tcs = this.msg().toolCalls;
    if (!tcs?.length) return null;
    const last = tcs[tcs.length - 1];
    return (last.result === undefined && !last.isError) ? last : null;
  });

  /**
   * True only for the single in-flight tool call (the last one still running)
   * while the message streams. Tools run sequentially, so once the agent moves
   * on, an earlier card must not keep the "running" chip just because its
   * result hasn't been back-filled yet — only the last unfinished one is live.
   */
  isToolInFlight(tc: ToolCallRecord | null | undefined): boolean {
    if (!tc || this.msg().streaming !== true) return false;
    return this.inFlightToolCall()?.id === tc.id;
  }

  /** The i18n key + params for the progress verb. */
  readonly progressLabel = computed<string>(() => {
    const tc = this.inFlightToolCall();
    if (!tc) return this.translate.instant('bubble_progress.thinking');
    const summary = summarizeToolCall(tc);
    return this.translate.instant(summary.key, summary.params ?? {});
  });

  /** Short path/command argument for the progress line, or empty string. */
  readonly progressArg = computed<string>(() => {
    const tc = this.inFlightToolCall();
    return tc ? toolArg(tc) : '';
  });

  readonly hasThinking = computed(() => !!this.msg().thinking);

  /**
   * Resolved sanitized HTML string, or `null` when DOMPurify is unavailable
   * or throws. A `null` return tells the template to fall back to plain-text
   * interpolation so thinking content is never silently swallowed.
   */
  private readonly _sanitizedThinkingHtml = computed<string | null>(() => {
    const raw = this.msg().thinking ?? '';
    if (!raw) return null;
    try {
      return (typeof DOMPurify !== 'undefined') ? DOMPurify.sanitize(raw) : null;
    } catch {
      return null;
    }
  });

  readonly renderedThinkingHtml = computed<SafeHtml>(() =>
    this.sanitizer.bypassSecurityTrustHtml(this._sanitizedThinkingHtml() ?? ''),
  );

  /** True when DOMPurify is absent or threw — template uses plain-text interpolation. */
  readonly thinkingUsePlainText = computed(() => this._sanitizedThinkingHtml() === null);

  readonly usageLabel = computed<string | null>(() => {
    const u = this.msg().usage;
    if (!u) return null;
    const inp = (u.inputTokens ?? 0).toLocaleString();
    const out = (u.outputTokens ?? 0).toLocaleString();
    const reasoningPart = u.reasoningOutputTokens != null && u.reasoningOutputTokens > 0
      ? ` · 🧠 ${u.reasoningOutputTokens.toLocaleString()}`
      : '';
    const costUsd = u.costUsd;
    const costPart =
      costUsd != null && !isNaN(costUsd) && costUsd >= 0
        ? ` · $${costUsd.toFixed(4)}`
        : '';
    return `↑ ${inp} ↓ ${out} tokens${reasoningPart}${costPart}`;
  });

  /**
   * REV-AGENT-CORE-006: short label for the run mode badge. Returns `null`
   * when the message has no mode (legacy persisted messages).
   * 'apply' is the default; we suppress its badge to avoid visual noise.
   */
  readonly modeLabel = computed<string | null>(() => {
    const m = this.msg().mode;
    if (m === 'plan') return 'Plan';
    if (m === 'apply-yolo') return 'YOLO';
    return null;
  });

  readonly agentLabel = computed<string | null>(() => {
    const m = this.msg();
    const parts = [m.agentId, m.model].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  });

  readonly statusIcon = computed<string | null>(() => {
    switch (this.msg().runStatus) {
      case 'failed':   return 'warning';
      case 'canceled': return 'cancel';
      default:         return null;
    }
  });

  /**
   * 15-state mascot contract. Derived from the same signals the bubble already
   * uses, so it tracks real run/tool state instead of a timer:
   */
  readonly avatarState = computed<DvChatAvatarState>(() => {
    if (!this.isLatest()) return 'idle';

    const m = this.msg();
    const lastTool = m.toolCalls?.at(-1) ?? null;

    if (lastTool && isAskUserTool(lastTool.name) && lastTool.result === undefined && !lastTool.isError) return 'asking';
    if (m.runStatus === 'failed') return 'error';
    if (m.runStatus === 'canceled') return 'paused';
    if (m.toolCalls?.some((tc) => tc.isError)) return 'warning';

    if (m.streaming) {
      const liveTool = this.inFlightToolCall();
      if (liveTool) return avatarStateForToolCall(liveTool);
      if (this.hasThinking()) return 'thinking';
      const hasStreamingText =
        !!m.text?.trim() ||
        (m.contentBlocks ?? []).some((block) => block.kind === 'text' && block.text.trim().length > 0);
      return hasStreamingText ? 'streaming' : 'thinking';
    }

    if (this.justCompleted()) return 'success';
    return 'idle';
  });

  /** Flips to true for ~1.4s after a successful copy so the icon swaps to a
   *  check mark and the tooltip confirms. Per-instance signal so two bubbles
   *  copied in quick succession don't share the flash. */
  readonly copied = signal(false);
  private copyResetTimer: ReturnType<typeof setTimeout> | null = null;

  async copyToClipboard() {
    const text = this.msg().text ?? '';
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(true);
      if (this.copyResetTimer) clearTimeout(this.copyResetTimer);
      this.copyResetTimer = setTimeout(() => this.copied.set(false), 1400);
    } catch (err) {
      // Electron 41 sandbox grants clipboard permission to the app origin
      // by default, so a failure here is almost always a focus/transient
      // issue (e.g. devtools focused). Log instead of toasting so we don't
      // alarm users — they can retry.
      console.error('[chat] clipboard write failed:', err);
    }
  }

  // Friendly verbs for the technical tool names Claude streams. The mapping
  // stays in code (tool names → i18n keys); the human-readable strings live
  // in i18n/<lang>.json under `message_bubble.tool_*`.
  toolLabel(name: string): string {
    if (name.startsWith("mcp__")) return this.translate.instant('message_bubble.tool_consulting');
    if (name === "Skill" || name.startsWith("skill:"))
      return this.translate.instant('message_bubble.tool_pulling_skills');
    const map: Record<string, string> = {
      Read: 'message_bubble.tool_reading',
      NotebookRead: 'message_bubble.tool_reading',
      Write: 'message_bubble.tool_writing',
      Edit: 'message_bubble.tool_editing',
      MultiEdit: 'message_bubble.tool_editing',
      NotebookEdit: 'message_bubble.tool_editing',
      Grep: 'message_bubble.tool_researching',
      Glob: 'message_bubble.tool_researching',
      Bash: 'message_bubble.tool_executing',
      WebFetch: 'message_bubble.tool_web_search',
      WebSearch: 'message_bubble.tool_web_search',
      TodoWrite: 'message_bubble.tool_organizing',
      TaskCreate: 'message_bubble.tool_organizing',
      TaskUpdate: 'message_bubble.tool_organizing',
      TaskList: 'message_bubble.tool_organizing',
      TaskGet: 'message_bubble.tool_organizing',
      TaskStop: 'message_bubble.tool_organizing',
      TaskOutput: 'message_bubble.tool_organizing',
      Task: 'message_bubble.tool_delegating',
      Agent: 'message_bubble.tool_delegating',
      Plan: 'message_bubble.tool_planning',
      EnterPlanMode: 'message_bubble.tool_planning',
      ExitPlanMode: 'message_bubble.tool_planning',
    };
    const key = map[name];
    return key
      ? this.translate.instant(key)
      : this.translate.instant('message_bubble.tool_using', { name });
  }
}
