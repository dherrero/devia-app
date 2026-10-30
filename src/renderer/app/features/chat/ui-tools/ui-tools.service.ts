import { Injectable, effect, inject, signal } from '@angular/core';

import type { UiToolRequestEvent } from '../../../../../shared/contracts/events';
import type { ChatMessage } from '../../../../../shared/domain/chat';
import {
  normalizePlanApproveInput,
  renderPlanApproveResult,
  type PlanApproveInput,
  type PlanApproveResult,
  type TodoItem,
  type UiToolName,
} from '../../../../../shared/domain/ui-tools';
import { AppStateService } from '../../../core/services/app-state.service';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';

/**
 * Live `devia-ui` tool requests, keyed by session (S-25 F1.3).
 *
 * The key is the same `sessionKey = runKey ?? effectiveProject` every other bit
 * of per-pane state uses, so in split view a card is drawn by the pane that
 * owns the run and by no other.
 *
 * The question card is NOT routed here: it keeps its S-24 `question:ask` path
 * so persisted transcripts and the existing renderer keep working untouched.
 */

export interface PendingUiTool {
  callId: string;
  tool: UiToolName;
  input: unknown;
  expectsAnswer: boolean;
  /** Wall-clock arrival, so a card can show how long the agent has been waiting. */
  since: number;
  /** The plan step that was current when the agent asked, if a plan is running. */
  stepId?: string;
}

/** What the user answered inside a step, kept as a one-line note on it. */
export type StepNoteKind = 'confirmed' | 'always' | 'declined' | 'picked' | 'pick_cancelled';

export interface StepNote {
  kind: StepNoteKind;
  detail: string;
}

/**
 * The run's step list as the execution panel draws it (S-28 T-339).
 *
 * `carryOver` exists for one transition only: approving a plan seeds the steps
 * at once, but the planning run ends right after and its end would wipe them
 * before the follow-up run has published its own list. A carried-over state
 * survives exactly one run end.
 */
export interface ExecutionState {
  steps: TodoItem[];
  carryOver: boolean;
  notes: Record<string, StepNote[]>;
}

@Injectable({ providedIn: 'root' })
export class UiToolsService {
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly appState = inject(AppStateService);

  private readonly pending = signal<Record<string, PendingUiTool[]>>({});

  /**
   * Calls already answered or dropped, per session. A late re-emission of one of
   * them must not bring its card back (S-28 T-334): the request file outlives
   * the answer until the server reads it, and main used to re-send it on every
   * poller tick. Main no longer does, but a resurrected card is unanswerable, so
   * the renderer guards it too.
   */
  private readonly settled = new Map<string, Set<string>>();

  /** All live requests, keyed by session. */
  readonly pendingUiRequests = this.pending.asReadonly();

  private readonly execution = signal<Record<string, ExecutionState>>({});

  /** Step list + per-step notes, keyed by session. */
  readonly executionStates = this.execution.asReadonly();

  constructor() {
    this.api.onUiToolRequest((event: UiToolRequestEvent) => this.receive(event));

    // A session's cards belong to its run. When the run ends — finished,
    // cancelled, killed by a reset or by closing its pane — nothing can answer
    // them any more, so the panel empties. The persisted `kind:'todo'` message
    // in the thread is the history that survives.
    let wasRunning: ReadonlySet<string> = new Set();
    effect(() => {
      const running = this.appState.runningPaths();
      for (const key of wasRunning) {
        if (!running.has(key)) this.clear(key);
      }
      wasRunning = new Set(running);
    });
  }

  requestsFor(sessionKey: string): PendingUiTool[] {
    return this.pending()[sessionKey] ?? [];
  }

  /**
   * Send the user's resolution back to the agent and drop the card.
   *
   * A fire-and-forget request has nothing to send: it is replaced by the next
   * one of its kind, or cleared when the pane goes away.
   */
  resolve(sessionKey: string, callId: string, answer: string, note?: StepNote): void {
    const entry = this.requestsFor(sessionKey).find((r) => r.callId === callId);
    this.drop(sessionKey, callId);
    if (entry?.expectsAnswer) void this.api.sendUiToolResult(sessionKey, callId, answer);
    if (note && entry?.stepId) this.addNote(sessionKey, entry.stepId, note);
  }

  executionFor(sessionKey: string): ExecutionState | null {
    return this.execution()[sessionKey] ?? null;
  }

  /**
   * Answer a plan card and keep the decision in the thread (S-28 T-337).
   *
   * Answered FIRST: the agent is blocked on this call. Returns the plan so the
   * caller can queue its follow-up run; null when the card is gone.
   */
  resolvePlan(sessionKey: string, callId: string, result: PlanApproveResult): PlanApproveInput | null {
    const entry = this.requestsFor(sessionKey).find((r) => r.callId === callId);
    this.resolve(sessionKey, callId, renderPlanApproveResult(result));
    const plan = entry ? normalizePlanApproveInput(entry.input) : null;
    if (!plan) return null;
    if (result.decision === 'approve_and_run' && plan.steps?.length) {
      this.setSteps(
        sessionKey,
        plan.steps.map((st, i) => ({
          id: st.id,
          text: st.text,
          status: i === 0 ? 'in_progress' : 'pending',
        })),
        true,
      );
    }
    this.appState.appendPlanMessage(sessionKey, {
      ...plan,
      decision: result.decision,
      ...(result.comment ? { comment: result.comment } : {}),
      decidedAt: Date.now(),
    });
    return plan;
  }

  /** Remove a card without answering (pane closed, session switched). */
  drop(sessionKey: string, callId: string): void {
    this.settle(sessionKey, callId);
    this.pending.update((all) => {
      const next = (all[sessionKey] ?? []).filter((r) => r.callId !== callId);
      return withKey(all, sessionKey, next);
    });
  }

  /**
   * Forget every card of a session. The runner's blocking timeout is the safety
   * net for an unanswered call, so dropping locally can never wedge a run.
   */
  clear(sessionKey: string): void {
    this.settled.delete(sessionKey);
    this.pending.update((all) => withKey(all, sessionKey, []));
    this.execution.update((all) => {
      const current = all[sessionKey];
      if (current?.carryOver) return { ...all, [sessionKey]: { ...current, carryOver: false } };
      const { [sessionKey]: _dropped, ...rest } = all;
      return rest;
    });
  }

  private setSteps(sessionKey: string, steps: TodoItem[], carryOver: boolean): void {
    this.execution.update((all) => ({
      ...all,
      [sessionKey]: { steps, carryOver, notes: all[sessionKey]?.notes ?? {} },
    }));
  }

  private addNote(sessionKey: string, stepId: string, note: StepNote): void {
    this.execution.update((all) => {
      const current = all[sessionKey];
      if (!current) return all;
      const notes = { ...current.notes, [stepId]: [...(current.notes[stepId] ?? []), note] };
      return { ...all, [sessionKey]: { ...current, notes } };
    });
  }

  private activeStepId(sessionKey: string): string | undefined {
    const steps = this.execution()[sessionKey]?.steps ?? [];
    return (steps.find((st) => st.status === 'in_progress') ?? steps.find((st) => st.status === 'pending'))?.id;
  }

  private settle(sessionKey: string, callId: string): void {
    const set = this.settled.get(sessionKey) ?? new Set<string>();
    set.add(callId);
    // Bounded: a run cleared at its end never grows this past one run's calls,
    // but a session that stays running for hours must not grow it forever.
    if (set.size > MAX_SETTLED_PER_SESSION) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
    this.settled.set(sessionKey, set);
  }

  private receive(event: UiToolRequestEvent): void {
    // `notify` has no card: its real delivery (OS notification, chat relay)
    // already happened in main. The window only gets it when it is focused,
    // and a toast is the non-intrusive equivalent there.
    if (event.tool === 'notify') {
      const payload = event.input as { title?: string; body?: string; level?: string } | null;
      const title = typeof payload?.title === 'string' ? payload.title : '';
      if (!title) return;
      const body = typeof payload?.body === 'string' ? payload.body : '';
      this.toast.show(body ? `${title} — ${body}` : title, {
        kind: payload?.level === 'error' ? 'error' : payload?.level === 'warn' ? 'warning' : 'info',
      });
      return;
    }

    // `todo` is also persisted into the thread so it survives reopening the
    // session; the live card above the composer is the in-flight view of the
    // same list.
    if (event.tool === 'todo') {
      const items = (event.input as { items?: TodoItem[] } | null)?.items;
      if (Array.isArray(items) && items.length > 0) {
        this.appState.upsertTodoMessage(event.project, items);
        // The list IS the execution panel now: it is drawn as the stepper, not
        // as a card of its own.
        this.setSteps(event.project, [...items], false);
      }
      return;
    }

    if (this.settled.get(event.project)?.has(event.callId)) return;

    // `send_file` is not a card either: main only accepted the file and uploads
    // it to Telegram after the run ends (it can still fail or be skipped if the
    // run is stopped). The thread keeps it as an outbox card, labelled neutrally
    // "for Telegram", that survives reopening the session.
    if (event.tool === 'send_file') {
      this.settle(event.project, event.callId);
      const message = sentFileMessage(event.callId, event.input);
      if (message) this.appState.addMessage(event.project, message);
      return;
    }

    const entry: PendingUiTool = {
      callId: event.callId,
      tool: event.tool,
      input: event.input,
      expectsAnswer: event.expectsAnswer,
      since: Date.now(),
    };
    const stepId = this.activeStepId(event.project);
    if (stepId) entry.stepId = stepId;
    this.pending.update((all) => {
      const current = all[event.project] ?? [];
      if (current.some((r) => r.callId === entry.callId)) return all;
      // A fire-and-forget tool is a live status card, not a queue: a new one
      // replaces the previous, or a long run would stack dozens of them.
      const kept = entry.expectsAnswer ? current : current.filter((r) => r.tool !== entry.tool);
      return withKey(all, event.project, [...kept, entry]);
    });
  }
}

const MAX_SETTLED_PER_SESSION = 200;

const SENT_FILE_KIND: Record<string, NonNullable<ChatMessage['kind']>> = {
  photo: 'image',
  video: 'video',
};

/** The thread record of a file `devia_send_file` queued for Telegram (S-32); delivery happens after the run. */
function sentFileMessage(callId: string, input: unknown): ChatMessage | null {
  const file = input as { path?: unknown; name?: unknown; kind?: unknown } | null;
  if (typeof file?.path !== 'string' || !file.path) return null;
  const name = typeof file.name === 'string' && file.name ? file.name : file.path;
  return {
    id: `outbox-${callId}`,
    role: 'outbox',
    name,
    kind: (typeof file.kind === 'string' && SENT_FILE_KIND[file.kind]) || 'file',
    path: file.path,
    channel: 'telegram',
  };
}

function withKey(
  all: Record<string, PendingUiTool[]>,
  key: string,
  value: PendingUiTool[],
): Record<string, PendingUiTool[]> {
  if (value.length === 0) {
    const { [key]: _dropped, ...rest } = all;
    return rest;
  }
  return { ...all, [key]: value };
}
