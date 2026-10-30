import * as fs from 'node:fs';
import * as path from 'node:path';

import type { RunId } from '../../../../shared/domain/agent';
import type { QuestionPrompt } from '../../../../shared/contracts/events';
import { normalizeAskUserQuestionInput } from '../../../../shared/domain/question-ask';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import {
  classifyUiDecision,
  isBlockingUiTool,
  normalizeUiToolInput,
  renderConfirmResult,
  uiToolPublicName,
  type NormalizedSendFile,
  type UiToolName,
} from '../../../../shared/domain/ui-tools';
import {
  isRequestFileName,
  readUiRequest,
  removeUiCall,
  writeUiAnswer,
} from '../../../shared/ui-rendezvous';
import type { AgentAnswer, AgentUiRequest } from '../../agents/domain';
import type { AgentAuditLog } from '../../security/audit-log';
import { auditSendFile, type RunFileGate } from '../../../shared/outbound-file-gate';
import type { AgentProcessHandle } from '../domain/ports';
import { REMOTE_QUESTION_UNAVAILABLE_ANSWER } from '../infrastructure/remote-protocol';
import type { RunInstructionHandlers } from './run-instruction.use-case';

/**
 * Claude Code removed this tool from headless runs (Devia asks through
 * `devia_ask_user` instead). Kept as a safety net for any agent that still
 * exposes a built-in picker under this name.
 */
export const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

export interface RunInteractionContext {
  readonly runId: RunId;
  readonly agentId: string;
  readonly projectName: string;
  /** Base checkout: the identity of the "always allow" grants. */
  readonly projectCheckout: string;
  readonly cwd: string;
  /** Per-run `devia-ui` rendezvous directory. */
  readonly uiDir: string;
  readonly mode: RunMode;
  readonly isRemote: boolean;
  /** The `devia-ui` tools this run was given (decided before the prompt). */
  readonly advertised: readonly UiToolName[];
  /**
   * S-32: this run's send-file policy (`canSendFiles`, `sendRoots`) and
   * counter. Every `devia_send_file` request is revalidated through it before
   * it reaches the handlers; absent ⇒ every request is refused.
   */
  readonly files?: RunFileGate;
  readonly timeoutMs: number;
  readonly handlers: Pick<RunInstructionHandlers, 'onQuestionAsk' | 'onUiToolRequest' | 'onRunFileRejected'>;
  readonly auditLog?: AgentAuditLog;
  readonly isConfirmationGranted?: (projectAbs: string, action: string) => boolean;
  readonly grantConfirmation?: (projectAbs: string, action: string, agentId: string) => void;
}

/**
 * Everything one run needs to put a question in front of the user and carry
 * the answer back (S-25, S-30) — agent-agnostic:
 *
 * - `devia-ui` tools: polls the rendezvous directory, draws each card once,
 *   writes the answer file;
 * - dialogs the agent raised natively (`AgentUiRequest`), and an agent's own
 *   built-in `AskUserQuestion` picker;
 * - one kill timer for whatever blocking card is pending;
 * - one routing point for the renderer's answer (`answer`).
 */
export class RunInteraction {
  /** Tool-use / call ids already handled: a card is drawn ONCE (S-28 T-333). */
  private readonly seen = new Set<string>();
  private readonly askUserQuestionPrompts = new Map<string, QuestionPrompt[]>();
  /** Blocking `devia-ui` calls awaiting the user (answered by rendezvous). */
  private readonly pendingUiCalls = new Map<string, UiToolName>();
  /** The action each live confirm asked about, so "always" knows what to persist. */
  private readonly pendingConfirmActions = new Map<string, string>();
  /** Dialogs the agent raised natively (answered through its own channel). */
  private readonly nativeUiRequests = new Map<string, AgentUiRequest>();
  private readonly uiToolHandlers: Partial<Record<UiToolName, (callId: string, input: unknown) => void>> = {};
  private questionTimer: ReturnType<typeof setTimeout> | null = null;
  private poller: ReturnType<typeof setInterval> | null = null;
  private handle: AgentProcessHandle | null = null;

  constructor(private readonly ctx: RunInteractionContext) {
    this.registerUiToolHandlers();
  }

  /** The spawned agent — target of native answers and of the kill timer. */
  attach(handle: AgentProcessHandle): void {
    this.handle = handle;
  }

  /** Start polling the rendezvous — only when the run was given `devia-ui`. */
  start(): void {
    if (this.ctx.advertised.length === 0) return;
    this.poller = setInterval(() => this.pollRendezvous(), 100);
    (this.poller as { unref?: () => void }).unref?.();
  }

  /**
   * End of the run. Called BEFORE the rendezvous dir is removed and before
   * the outbox flush / `onProcessEnd`, so one last sweep still delivers a
   * fire-and-forget request (`devia_send_file`) written in the poller's final
   * 100 ms — its `file` event then reaches the relay ahead of `end`. Blocking
   * requests are left alone: nobody is left to read an answer.
   */
  stop(): void {
    if (this.poller !== null) {
      clearInterval(this.poller);
      this.poller = null;
      this.pollRendezvous({ fireAndForgetOnly: true });
    }
    this.clearQuestionTimer();
  }

  clearQuestionTimer(): void {
    if (this.questionTimer !== null) {
      clearTimeout(this.questionTimer);
      this.questionTimer = null;
    }
  }

  /**
   * First sighting of a tool call. Claude can report the same `tool_use`
   * through both the SDK stream and its final wrapper; the id is the
   * idempotency key, so callers count / audit it once.
   */
  firstSighting(toolUseId: string): boolean {
    if (this.seen.has(toolUseId)) return false;
    this.seen.add(toolUseId);
    return true;
  }

  /** An agent's own built-in picker (`AskUserQuestion`), seen on its stream. */
  surfaceBuiltInQuestion(toolUseId: string, input: unknown): void {
    if (!this.ctx.handlers.onQuestionAsk) return;
    this.seen.delete(toolUseId);
    this.surfaceAskUserQuestion(toolUseId, input);
  }

  /**
   * A dialog the agent raised through its OWN channel (pi extension UI, ACP
   * permission), already in Devia's terms. Drawn with the same cards as the
   * `devia-ui` tools; false when nothing can draw it, so the session applies
   * its headless default instead of hanging.
   */
  surfaceAgentUiRequest(req: AgentUiRequest): boolean {
    const { handlers } = this.ctx;
    if (req.purpose === 'permission') {
      if (!handlers.onQuestionAsk) return false;
      this.nativeUiRequests.set(req.callId, req);
      this.surfaceAskUserQuestion(
        req.callId,
        { question: req.title, options: (req.options ?? []).map((o) => ({ label: o.label })) },
        'permission',
      );
      return true;
    }
    if (req.kind === 'confirm' && handlers.onUiToolRequest) {
      const action = req.message ? `${req.title}\n\n${req.message}` : req.title;
      // S-25 F2.4: an action the user already chose to always allow.
      if (this.ctx.isConfirmationGranted?.(this.ctx.projectCheckout, action)) {
        this.handle?.answer(req.callId, { kind: 'confirm', confirmed: true });
        return true;
      }
      this.nativeUiRequests.set(req.callId, req);
      this.pendingConfirmActions.set(req.callId, action);
      this.audit('confirm', req.callId, 'request');
      handlers.onUiToolRequest(req.callId, 'confirm', { action }, this.ctx.runId, true);
      return true;
    }
    if (!handlers.onQuestionAsk) return false;
    this.nativeUiRequests.set(req.callId, req);
    this.armTimer(`agent dialog ${req.callId}`, () => this.nativeUiRequests.delete(req.callId));
    const options = (req.options ?? []).map((o) => ({ label: o.label, ...(o.description !== undefined && { description: o.description }) }));
    if (options.length > 0) handlers.onQuestionAsk(req.callId, req.title, this.ctx.runId, options);
    else handlers.onQuestionAsk(req.callId, req.title, this.ctx.runId);
    return true;
  }

  /** The renderer's answer to ANY card, as the string the IPC carries. */
  answer(toolUseId: string, content: string): void {
    this.clearQuestionTimer();
    // A dialog the agent raised natively: back through its own channel.
    const native = this.nativeUiRequests.get(toolUseId);
    if (native) {
      this.nativeUiRequests.delete(toolUseId);
      const action = this.pendingConfirmActions.get(toolUseId);
      this.pendingConfirmActions.delete(toolUseId);
      if (native.kind === 'confirm' && action && classifyUiDecision('confirm', content) === 'always') {
        this.ctx.grantConfirmation?.(this.ctx.projectCheckout, action, this.ctx.agentId);
      }
      this.handle?.answer(toolUseId, toAgentAnswer(native, content));
      return;
    }
    const prompts = this.askUserQuestionPrompts.get(toolUseId);
    const pendingTool = this.pendingUiCalls.get(toolUseId);
    if (prompts || pendingTool) {
      const tool = pendingTool ?? 'ask_user';
      const decision = classifyUiDecision(tool, content);
      this.audit(tool, toolUseId, decision ? `answered:${decision}` : 'answered');
      if (decision === 'always') {
        const action = this.pendingConfirmActions.get(toolUseId);
        if (action) this.ctx.grantConfirmation?.(this.ctx.projectCheckout, action, this.ctx.agentId);
      }
      this.askUserQuestionPrompts.delete(toolUseId);
      this.pendingUiCalls.delete(toolUseId);
      this.pendingConfirmActions.delete(toolUseId);
      writeUiAnswer(this.ctx.uiDir, toolUseId, content);
      return;
    }
    // An agent's own built-in picker, answered on its stdin (Claude's legacy
    // AskUserQuestion over stream-json).
    this.handle?.answer(toolUseId, { kind: 'text', text: content });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  /**
   * S-25 F1.5: every UI-tool call is auditable — the agent is asking the user
   * to approve plans, confirm destructive commands, pick files. Metadata only,
   * never the payload (it can carry host paths or file contents).
   */
  private audit(tool: UiToolName, callId: string, phase: string): void {
    this.ctx.auditLog?.append({
      ts: Date.now(),
      agentId: this.ctx.agentId,
      project: this.ctx.projectName,
      tool: uiToolPublicName(tool),
      runId: this.ctx.runId,
      mode: this.ctx.mode,
      summary: `${phase} ${callId}`,
    });
  }

  private auditFileRejected(reason: string): void {
    auditSendFile(
      this.ctx.auditLog,
      { agentId: this.ctx.agentId, project: this.ctx.projectName, runId: this.ctx.runId, mode: this.ctx.mode },
      `rejected:${reason}`,
    );
  }

  /**
   * A `devia_send_file` request the main process refused on revalidation (the
   * file changed since the server's check, the per-run limit, a hand-written
   * request…). The agent was already told "queued", so the chat must learn it
   * did not go out: published as `file_rejected`, name + reason only.
   */
  private reportToolFileRejected(request: NormalizedSendFile, reason: string): void {
    const name = path.basename(request.path.trim()) || request.path;
    this.ctx.handlers.onRunFileRejected?.({ name, reason, source: 'tool' }, this.ctx.runId);
  }

  /**
   * REV-TS-CLI-05-01: a blocking card left unanswered would hold the project
   * busy forever, so the run is killed after the timeout. One timer: a new
   * card re-arms it, an answer or a final turn end clears it.
   */
  private armTimer(label: string, onTimeout: () => void = () => undefined): void {
    this.clearQuestionTimer();
    this.questionTimer = setTimeout(() => {
      this.questionTimer = null;
      onTimeout();
      console.warn(
        `[devia] ${label} timeout: killing ${this.ctx.agentId} after ${this.ctx.timeoutMs / 1000}s with no answer (cwd: ${this.ctx.cwd})`,
      );
      this.handle?.kill('question_timeout');
    }, this.ctx.timeoutMs);
  }

  private surfaceAskUserQuestion(toolUseId: string, input: unknown, kind: 'question' | 'permission' = 'question'): void {
    const { handlers } = this.ctx;
    if (!handlers.onQuestionAsk) return;
    if (this.seen.has(toolUseId)) return;
    this.seen.add(toolUseId);

    const normalized = normalizeAskUserQuestionInput(input);
    // A remote (Telegram) user cannot click a card: answer with a canned
    // result telling the agent to re-ask in plain text, instead of a card the
    // timeout would resolve by killing the run. Permission requests are left
    // alone (approving or denying blindly would be unsafe). A remote run gets
    // no `devia_ask_user`, so only an agent's OWN picker can reach here.
    if (this.ctx.isRemote && kind === 'question') {
      this.handle?.answer(toolUseId, { kind: 'text', text: REMOTE_QUESTION_UNAVAILABLE_ANSWER });
      return;
    }
    this.audit('ask_user', toolUseId, 'request');
    this.askUserQuestionPrompts.set(toolUseId, normalized.questions);
    handlers.onQuestionAsk(toolUseId, normalized.question, this.ctx.runId, normalized.options, normalized.questions);
    this.armTimer('AskUserQuestion', () => this.audit('ask_user', toolUseId, 'timeout'));
  }

  /**
   * S-25: one handler per UI tool. The poller multiplexes on the request's
   * `tool`, so adding a tool is adding an entry here — not another poller,
   * certainly not another MCP server.
   */
  private registerUiToolHandlers(): void {
    const { handlers } = this.ctx;
    if (handlers.onQuestionAsk) {
      this.uiToolHandlers.ask_user = (callId, input): void => this.surfaceAskUserQuestion(callId, input);
    }
    if (!handlers.onUiToolRequest) return;
    for (const tool of this.ctx.advertised) {
      if (tool === 'ask_user') continue;
      this.uiToolHandlers[tool] = (callId, input): void => {
        // A blocking request stays on disk until the server reads its answer,
        // so the poller sees it on many ticks (S-28 T-333).
        if (!this.firstSighting(callId)) return;
        const normalized = normalizeUiToolInput(tool, input);
        if (normalized === null) {
          writeUiAnswer(this.ctx.uiDir, callId, 'The arguments were unusable. Fix them and call the tool again, or continue without it.');
          return;
        }
        const blocking = isBlockingUiTool(tool);
        let forwarded: unknown = normalized;
        if (tool === 'send_file') {
          // Never trust the request file: revalidate in main (S-32). The gate
          // audits the outcome; a refused file goes nowhere.
          const request = normalized as NormalizedSendFile;
          const admission = this.ctx.files?.admit(request, 'tool');
          if (!admission) this.auditFileRejected('not_offered');
          if (!admission?.ok) {
            this.reportToolFileRejected(request, admission?.reason ?? 'not_offered');
            return;
          }
          forwarded = admission.file;
        }
        if (tool === 'confirm') {
          const action = (normalized as { action?: string }).action ?? '';
          // S-25 F2.4: an action the user already chose to always allow is
          // answered without a card, audited as `auto`.
          if (this.ctx.isConfirmationGranted?.(this.ctx.projectCheckout, action)) {
            this.audit(tool, callId, 'answered:auto');
            writeUiAnswer(this.ctx.uiDir, callId, renderConfirmResult({ decision: 'always' }));
            return;
          }
          if (action) this.pendingConfirmActions.set(callId, action);
        }
        this.audit(tool, callId, 'request');
        if (blocking) {
          this.pendingUiCalls.set(callId, tool);
          this.armTimer(`devia_${tool}`, () => this.audit(tool, callId, 'timeout'));
        }
        handlers.onUiToolRequest?.(callId, tool, forwarded, this.ctx.runId, blocking);
      };
    }
  }

  private pollRendezvous(opts: { fireAndForgetOnly?: boolean } = {}): void {
    let entries: string[];
    try {
      entries = fs.readdirSync(this.ctx.uiDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!isRequestFileName(entry)) continue;
      const request = readUiRequest(path.join(this.ctx.uiDir, entry));
      if (!request) continue;
      if (opts.fireAndForgetOnly && request.expectsAnswer) continue;
      const handler = this.uiToolHandlers[request.tool];
      if (handler) {
        handler(request.callId, request.toolInput);
        // Fire-and-forget: nothing else will ever clear it; sweep it now or
        // the poller re-emits it every 100 ms for the rest of the run.
        if (!request.expectsAnswer) removeUiCall(this.ctx.uiDir, request.callId);
        continue;
      }
      // Advertised-but-unhandled should be impossible; answer rather than let
      // a blocking call hang until the kill timeout.
      if (request.expectsAnswer && this.firstSighting(request.callId)) {
        writeUiAnswer(this.ctx.uiDir, request.callId, 'This tool is not available in this Devia build. Continue without it.');
      } else if (!request.expectsAnswer) {
        // A send request for a run that was never offered the tool was
        // written by hand: worth a trace.
        if (request.tool === 'send_file' && this.firstSighting(request.callId)) this.auditFileRejected('not_offered');
        removeUiCall(this.ctx.uiDir, request.callId);
      }
    }
  }
}

/** The renderer's answer string, in the terms of the dialog the agent raised. */
export function toAgentAnswer(req: AgentUiRequest, content: string): AgentAnswer {
  // An ACP permission answer is the chosen option label, verbatim.
  if (req.purpose === 'permission') return { kind: 'select', value: content };
  if (req.kind === 'confirm') {
    return { kind: 'confirm', confirmed: content === 'yes' || content === 'always' || content.includes('CONFIRMED') };
  }
  if (content === 'cancelled' || content === 'canceled' || content.toLowerCase().includes('cancel')) {
    return { kind: 'cancel' };
  }
  return req.kind === 'select' ? { kind: 'select', value: content } : { kind: 'text', text: content };
}
