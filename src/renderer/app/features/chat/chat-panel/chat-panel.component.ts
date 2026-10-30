import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import { ButtonComponent, DialogService, IconComponent, TooltipDirective } from '@devia/ui';
import { firstValueFrom } from 'rxjs';
import { LucideChevronDown, LucideZap } from '@lucide/angular';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { AppStateService } from '../../../core/services/app-state.service';
import type { ChatMessage } from '../../../../../shared/domain/chat';
import { ElectronApiService } from '../../../core/services/electron-api.service';
import { ToastService } from '../../../core/services/toast.service';
import { EmptyStateComponent } from './components/empty-state/empty-state.component';
import { DiffViewerComponent } from './components/diff-viewer/diff-viewer.component';
import { VoiceRecorder, VoiceState } from './services/voice-recorder';
import { QueuePanelComponent } from '../queue/queue-panel.component';
import { AutoResumeBannerComponent } from '../auto-resume/auto-resume-banner.component';
import { UiToolHostComponent, type UiFollowUpRun } from '../ui-tools/ui-tool-host.component';
import { UiToolsService } from '../ui-tools/ui-tools.service';
import { renderRequestReviewResult } from '../../../../../shared/domain/ui-tools';
import {
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
  formatBytes,
} from '../../../../../shared/domain/attachment';
import { ChatScrollService } from './services/chat-scroll.service';
import { PendingAttachmentsService } from './services/pending-attachments.service';
import { ChatHeaderComponent } from './components/chat-header/chat-header.component';
import { MessagesFeedComponent } from './components/messages-feed/messages-feed.component';
import { AttachmentsBarComponent } from './components/attachments-bar/attachments-bar.component';
import { ModeBarComponent } from './components/mode-bar/mode-bar.component';
import { InputBarComponent } from './components/input-bar/input-bar.component';
import { ComposerDraftStore } from '../composer/composer-draft.store';
import { detectModeIntent, type ModeIntent } from './utils/auto-mode.util';
import type { ChatView } from './models/chat-view.model';

/**
 * Chat panel shell (HT-CH-01 phase 1).
 *
 * Orchestrates the chat view: header tabs, messages feed, queue panel,
 * attachments strip, question card, mode bar, composer and the drop
 * overlay. Phase 1 extracted two services and the two value models;
 * subsequent stories will split the template into dedicated
 * subcomponents (HT-CH-02..05, HT-MD-01, HT-IN-01).
 *
 * Extracted to:
 * - `services/chat-scroll.service.ts` — stickToBottom / showScrollFab
 *   signals + DOM-aware pin/computeFab helpers.
 * - `services/pending-attachments.service.ts` — image attachments list
 *   with managed object-URL lifecycle.
 * - `models/chat-view.model.ts`, `models/pending-attachment.model.ts`.
 */
@Component({
  selector: 'ds-chat-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [
    ButtonComponent,
    IconComponent,
    TooltipDirective,
    TranslateModule,
    EmptyStateComponent,
    DiffViewerComponent,
    QueuePanelComponent,
    AutoResumeBannerComponent,
    UiToolHostComponent,
    ChatHeaderComponent,
    MessagesFeedComponent,
    AttachmentsBarComponent,
    ModeBarComponent,
    InputBarComponent,
  ],
  // Each panel instance owns its own services so split-view panels
  // (T-149/T-143) carry independent scroll + attachment state.
  providers: [PendingAttachmentsService, ChatScrollService],
  templateUrl: './chat-panel.component.html',
  styleUrl: './chat-panel.component.scss',
})
export class ChatPanelComponent {
  readonly state = inject(AppStateService);
  readonly api = inject(ElectronApiService);
  readonly scroll = inject(ChatScrollService);
  readonly stickToBottom = this.scroll.stickToBottom;
  readonly attachments = inject(PendingAttachmentsService);
  private readonly toast = inject(ToastService);
  private readonly dialogs = inject(DialogService);

  // Session inputs (T-149). When bound (split view, T-143) they make this panel
  // instanceable N times, each driving its own project/session. When unbound
  // (the single provisional mount in chat-route) `effectiveProject` falls back
  // to the global selectedProject so the single-pane case is unchanged.
  readonly project = input<string | null>(null);
  readonly sessionId = input<string | null>(null);
  // T-143: an ADDITIONAL split pane passes a distinct runKey (its session
  // identity = worktree dir). When set, this pane keys ALL its live state by it
  // and runs isolated (own worktree). Unset ⇒ primary/single pane.
  readonly runKey = input<string | null>(null);

  // BASE project: the checkout the agent edits + what we display / resolve git
  // for. The explicit input wins; the fallback covers the single mount.
  readonly effectiveProject = computed(() => this.project() ?? this.state.selectedProject());

  // Per-pane session identity (T-145 worktreeDir-as-identity). For the primary
  // pane it equals the base project (single-pane unchanged); an additional pane
  // carries its runKey (worktree dir). ALL live-state reads key by this.
  readonly sessionKey = computed(() => this.runKey() ?? this.effectiveProject() ?? '');
  // True for an isolated additional pane that has its own git worktree (the
  // container sets it after creating the worktree). The state is still keyed by
  // runKey regardless; this only controls whether the run executes in a worktree.
  readonly isolate = input<boolean>(false);
  // S-3 F1.1: an additional pane whose worktree could NOT be created shares
  // files with the primary checkout — surfaced as a warning icon in the header.
  readonly unisolated = computed(() => this.runKey() !== null && !this.isolate());
  /** S-3 F2.1: the pane's cwd + worktree branch, persisted with the session
   *  so the restore chain can reattach the worktree after a restart. */
  readonly workdir = input<string | null>(null);
  readonly worktreeBranch = input<string | null>(null);
  private readonly translate = inject(TranslateService);
  private readonly injector = inject(Injector);
  private readonly draftStore = inject(ComposerDraftStore);
  private readonly uiTools = inject(UiToolsService);
  private readonly destroyRef = inject(DestroyRef);

  readonly inputBar = viewChild<InputBarComponent>('inputBar');

  readonly LucideChevronDown = LucideChevronDown;
  readonly LucideZap = LucideZap;

  /** Whether the quick-actions chips (next to the mode bar) are expanded. */
  readonly quickActionsOpen = signal(false);

  readonly draft = signal('');
  readonly dropActive = signal(false);
  readonly micState = signal<VoiceState>('idle');
  readonly view = signal<ChatView>('chat');

  /** Static quick-reply chips — i18n keys keep text out of TypeScript. */
  readonly quickReplies: ReadonlyArray<{ labelKey: string; textKey: string }> = [
    { labelKey: 'quick_replies.apply',       textKey: 'quick_replies.apply_text'       },
    { labelKey: 'quick_replies.explain',     textKey: 'quick_replies.explain_text'     },
    { labelKey: 'quick_replies.continue',    textKey: 'quick_replies.continue_text'    },
    { labelKey: 'quick_replies.add_tests',   textKey: 'quick_replies.add_tests_text'   },
    { labelKey: 'quick_replies.commit',      textKey: 'quick_replies.commit_text'      },
    { labelKey: 'quick_replies.commit_push', textKey: 'quick_replies.commit_push_text' },
    { labelKey: 'quick_replies.compact',     textKey: 'quick_replies.compact_text'     },
  ];

  private recorder: VoiceRecorder | null = null;
  private wslPasteWarned = false;
  private static readonly WINDOW_SIZE = 20;
  private static readonly LOAD_CHUNK = 10;
  readonly firstVisibleIdx = signal(0);
  private lastSessionKey = '';
  /** Last intent the reactive auto-mode applied; gates on transitions only so
   *  a manual mode change after a switch is not undone by further typing. */
  private lastAutoIntent: ModeIntent | null = null;
  readonly windowedMessages = computed<ChatMessage[]>(() =>
    this.currentMessages().slice(this.firstVisibleIdx()),
  );

  constructor() {
    effect(() => {
      this.sessionKey();
      this.view.set('chat');
    });

    // S-25 F2.3: the agent asked for a review, so take the user there. The
    // whole point of the tool is that the diff IS the conversation — leaving
    // them on the chat with a blocked agent and no visible reason would be
    // worse than the switch.
    effect(() => {
      if (this.pendingReview()) this.view.set('changes');
    });

    // Right-rail file tree → "open this file in Cambios". The tree sets
    // state.focusedDiffFile and we switch to the changes view; the diff
    // viewer reads the same signal, scrolls to the matching <article>
    // and clears it so subsequent clicks on the same file fire again.
    effect(() => {
      if (this.state.focusedDiffFile() !== null) this.view.set('changes');
    });

    // Snap to bottom whenever the user enters or re-enters the chat
    // view: initial mount of a project, switching to a different
    // project, or toggling Cambios → Chat. The messages-feed container
    // is gated by @if so scrollTop resets to 0 on every remount — we
    // have to re-apply it ourselves. rAF (not microtask) ensures we
    // read scrollHeight after layout has settled with the freshly-
    // hydrated messages. The argument-less `pin()` uses the container
    // registered by `MessagesFeedComponent` (HT-CH-03).
    effect(() => {
      this.sessionKey();
      this.view();
      this.scroll.reengageFollow();
      requestAnimationFrame(() => this.scroll.pin());
    });

    // S-14: the draft signal dies with this component on every route change
    // (the chat route is lazy-loaded, no RouteReuseStrategy), so unsent
    // composer state round-trips through the root ComposerDraftStore, keyed
    // by this pane's sessionKey. On a key change (component creation, primary
    // pane switching project, pane re-key on adoption) the stored draft is
    // RESTORED; on any other change the current draft is SAVED. Registered
    // BEFORE the composerInjection effect so an injection still wins the
    // first run (it executes later and overwrites the restored text).
    let draftSyncKey: string | null = null;
    effect(() => {
      const key = this.sessionKey();
      const draft = this.draft();
      const atts = this.attachments.items();
      if (!key) return;
      if (key !== draftSyncKey) {
        draftSyncKey = key;
        const saved = this.draftStore.snapshot(key);
        this.draft.set(saved?.draft ?? '');
        this.attachments.restore(saved?.attachments ?? []);
        return;
      }
      this.draftStore.save(key, { draft, attachments: atts });
    });
    // The effect above is scheduler-driven; a destroy can outrun its last
    // flush (type → navigate instantly), so capture the final state here.
    this.destroyRef.onDestroy(() => {
      const key = this.sessionKey();
      if (!key) return;
      this.draftStore.save(key, {
        draft: this.draft(),
        attachments: this.attachments.items(),
      });
    });

    // E-DSK-10 #268: sidebar shortcuts (and other features) prefill the
    // composer by writing to `AppStateService.composerInjection`.
    // Consume the value, focus the textarea via the input-bar's public
    // `focus()` hook and clear the signal so re-clicks of the same
    // shortcut re-fire this effect.
    effect(() => {
      const injected = this.state.composerInjection(this.sessionKey());
      if (injected === null) return;
      this.draft.set(injected);
      this.state.clearComposerInjection(this.sessionKey());
      requestAnimationFrame(() => this.inputBar()?.focus());
    });

    // Auto run-mode AS THE USER TYPES: react to the draft so the mode switch
    // is visible in the composer and the user can override it before sending
    // (the old send-time switch left no room to correct it). Runs after the
    // draft-restore and injection effects so restored/injected text is checked
    // too. Reset the transition tracker on a session change so re-entering a
    // pane re-evaluates from scratch.
    let autoModeKey: string | null = null;
    effect(() => {
      const key = this.sessionKey();
      const draft = this.draft();
      if (key !== autoModeKey) {
        autoModeKey = key;
        this.lastAutoIntent = null;
      }
      this.reconcileAutoMode(draft);
    });

    // Bottom-anchored windowing from main: reset to the tail on project
    // or session replacement, but preserve the mounted slice while the
    // user is reading history in the same session.
    effect(() => {
      const msgs = this.currentMessages();
      const firstId = msgs.length > 0 ? msgs[0].id : '';
      const key = `${this.sessionKey()}:${firstId}`;
      const isSessionChange = key !== this.lastSessionKey;
      this.lastSessionKey = key;

      if (isSessionChange || this.stickToBottom()) {
        this.firstVisibleIdx.set(Math.max(0, msgs.length - ChatPanelComponent.WINDOW_SIZE));
      }
    });

    // T-156: an ADDITIONAL split pane keys its live state by runKey (a synthetic
    // UUID) but its history must persist under the real base project with its
    // own session id, so the sessions navbar lists it and it survives a restart.
    // Register that redirect while mounted; the primary/single pane (no runKey)
    // never registers, so its disk layout is unchanged.
    effect((onCleanup) => {
      const key = this.runKey();
      const base = this.effectiveProject();
      const sid = this.sessionId();
      if (!key || !base || !sid) return;
      this.state.registerSessionPersistence(
        key,
        base,
        sid,
        this.workdir() ?? undefined,
        this.worktreeBranch() ?? undefined,
      );
      onCleanup(() => this.state.unregisterSessionPersistence(key));
    });
  }

  // ── Scroll handlers ───────────────────────────────────────────────────

  scrollToBottomSmooth(): void {
    this.scroll.pinSmooth();
  }

  onLoadOlder(scroller: HTMLElement): void {
    this.prependChunk(scroller);
  }

  private prependChunk(scroller: HTMLElement): void {
    const current = this.firstVisibleIdx();
    if (current === 0) return;

    const scrollHeightBefore = scroller.scrollHeight;
    const scrollTopBefore = scroller.scrollTop;
    this.firstVisibleIdx.set(Math.max(0, current - ChatPanelComponent.LOAD_CHUNK));

    afterNextRender(
      () => {
        const delta = scroller.scrollHeight - scrollHeightBefore;
        scroller.scrollTop = scrollTopBefore + delta;
      },
      { injector: this.injector },
    );
  }

  // ── Computed views ────────────────────────────────────────────────────

  readonly leafName = computed(() => {
    const p = this.effectiveProject();
    return p ? p.split('/').pop() ?? p : '';
  });

  readonly currentMessages = computed<ChatMessage[]>(() => {
    const k = this.sessionKey();
    return k ? this.state.chats().get(k) ?? [] : [];
  });

  readonly currentStream = computed<ChatMessage | null>(() => {
    const k = this.sessionKey();
    return k ? this.state.assistantStreams().get(k) ?? null : null;
  });

  // Stop button + "ejecutando" header chip. Reads the shared
  // runningPaths signal (via state.isRunning) so it can never disagree
  // with the sidebar dots or the statusbar pill — they all derive from
  // the same per-path source, which is immune to the navPath-filtered
  // projects() rebuilds that used to drop the flag mid-run.
  readonly currentRunning = computed(() => {
    const k = this.sessionKey();
    return k ? this.state.isRunning(k) : false;
  });

  /** Returns the pending question for the currently selected project,
   *  or null. REV-TS-CLI-05-04: reads from the per-project Map so
   *  parallel projects each keep their own pending question without
   *  clobbering each other. */
  readonly currentPendingQuestion = computed(() => {
    const k = this.sessionKey();
    if (!k) return null;
    return this.state.pendingQuestions().get(k) ?? null;
  });

  readonly canSend = computed(
    () =>
      (!!this.draft().trim() || this.attachments.hasAny) &&
      !!this.effectiveProject(),
  );

  /**
   * Quick-reply chips are visible only when all of the following hold:
   *   - the user is in the chat view
   *   - the draft composer is empty (chips disappear as soon as the user types)
   *   - there is no pending AskUserQuestion (the question card owns the space)
   *   - the selected project is not currently running an agent
   *   - there is at least one assistant message in the history (non-empty chat)
   */
  readonly showQuickActions = computed(
    () => this.view() === 'chat' && this.currentPendingQuestion() === null,
  );

  readonly micTooltip = computed(() => {
    // Read currentLang as a signal-ish dep so the tooltip refreshes
    // when the user switches languages mid-session (TranslateService
    // emits LangChange events but the value isn't a signal, so we tie
    // reactivity to micState and re-resolve through .instant() on
    // every read).
    switch (this.micState()) {
      case 'recording':
        return this.translate.instant('chat.mic_click_tooltip');
      case 'transcribing':
        return this.translate.instant('chat.mic_transcribing');
      default:
        return this.translate.instant('chat.mic_record_tooltip');
    }
  });

  // ── Send / instruction ────────────────────────────────────────────────

  /**
   * Submit a clicked AskUserQuestion option as the answer. Mirrors the
   * pending-question branch of `send()` without async/await — the optimistic
   * state update happens synchronously inside `answerQuestion`. The choice is
   * NOT added as a user message: the transcript keeps the question + selection
   * on the agent's side (see QuestionAnsweredCardComponent).
   */
  onAnswerQuestion(answer: string): void {
    const key = this.sessionKey();
    if (!key) return;
    this.scroll.reengageFollow();
    void this.state.answerQuestion(key, answer);
  }

  /** The question bubble's "write your own answer" button — focus the composer
   *  so the user can type a free-form reply (send() routes it as the answer
   *  while a question is pending). */
  onFreeform(): void {
    requestAnimationFrame(() => this.inputBar()?.focus());
  }

  /**
   * Send a quick action immediately, exactly as if the user had typed it: set
   * the composer text and route it through `send()` (which clears the draft and
   * adds the user message). Collapses the chips afterwards.
   */
  onQuickReply(textKey: string): void {
    if (!this.effectiveProject() || this.currentRunning()) return;
    this.quickActionsOpen.set(false);
    this.draft.set(this.translate.instant(textKey) as string);
    void this.send();
  }

  /**
   * Switch this pane's run-mode from the message intent, acting ONLY on a
   * transition of the detected intent so manual overrides survive further
   * typing. Guards mirror the original send-time logic:
   *
   * - Plan intent ("plan", "analiza"…) → `plan`, unless already there.
   * - Apply intent ("ejecuta", "run"…) → `apply`, but ONLY from `plan`;
   *   `apply`/`apply-yolo` are deliberately left untouched.
   *
   * Below 4 chars nothing is inspected (`detectModeIntent` → null resets the
   * tracker) so retyping the same verb re-triggers.
   */
  private reconcileAutoMode(text: string): void {
    const intent = text.trim().length > 3 ? detectModeIntent(text) : null;
    if (intent === this.lastAutoIntent) return;
    this.lastAutoIntent = intent;
    if (intent === null) return;

    const key = this.sessionKey();
    const currentMode = this.state.runMode(key);
    if (intent === 'plan' && currentMode !== 'plan') {
      this.state.setRunMode(key, 'plan');
      this.toast.show(this.translate.instant('mode.auto_plan_toast'), { kind: 'info' });
    } else if (intent === 'apply' && currentMode === 'plan') {
      this.state.setRunMode(key, 'apply');
      this.toast.show(this.translate.instant('mode.auto_apply_toast'), { kind: 'info' });
    }
  }

  async send(): Promise<void> {
    // `base` = the checkout the agent runs against (cwd source). `key` = this
    // pane's session identity, used for all live state + the runKey routing.
    const base = this.effectiveProject();
    const key = this.sessionKey();
    const text = this.draft().trim();
    if (!base || (!text && !this.attachments.hasAny)) return;

    // The user's own message always lands at the bottom — follow it
    // there even if they had scrolled up, so they see what they just
    // sent and the response that streams under it. The ResizeObserver
    // re-pins on growth.
    this.scroll.reengageFollow();

    // REV-TS-CLI-05-03: If there is a pending question for this
    // project, the user's input is treated as the answer and routed to
    // answerQuestion rather than sendInstruction. No user message is
    // added — the answered question renders inside the agent's bubble.
    const pendingQ = this.currentPendingQuestion();
    if (pendingQ && text) {
      this.draft.set('');
      this.draftStore.clear(key);
      await this.state.answerQuestion(key, text);
      return;
    }

    // Final reconcile of the auto run-mode: the reactive effect already
    // tracked the draft while typing, but a "type then immediately Enter"
    // can outrun the scheduler flush. Transition-gated, so it never overrides
    // a manual mode change the user made after the typing-time switch.
    this.reconcileAutoMode(text);

    // S-3 F1.1: an additional pane that could not get its own worktree shares
    // files with the primary checkout. First send asks for explicit consent
    // (once per pane; the draft survives a cancel).
    if (this.runKey() && !this.isolate() && !this.state.isUnisolatedAcknowledged(key)) {
      const ok = await firstValueFrom(
        this.dialogs.confirm({
          title: this.translate.instant('panes.no_isolation_confirm_title'),
          message: this.translate.instant('panes.no_isolation_confirm_message'),
          confirmLabel: this.translate.instant('panes.no_isolation_confirm_ok'),
          cancelLabel: this.translate.instant('panes.no_isolation_confirm_cancel'),
          danger: true,
        }),
      );
      if (!ok) return;
      this.state.acknowledgeUnisolated(key);
    }

    const atts = this.attachments.drain();
    this.draft.set('');
    this.draftStore.clear(key);

    const onlyImages = atts.every((a) => a.kind === 'image');
    const display =
      atts.length > 0
        ? `${text}${text ? '\n\n' : ''}${this.translate.instant(
            `chat.${onlyImages ? 'images' : 'files'}_attached${atts.length === 1 ? '' : '_plural'}`,
            { count: atts.length },
          )}`
        : text;

    const payloads = await PendingAttachmentsService.toPayloads(atts);

    // TS-CLI-11: record the raw prompt so "Retry" can resend it without
    // the user retyping. Stored in-memory only (not persisted to disk).
    this.state.storeLastPrompt(key, text);

    // Defer adding the user bubble until we know whether the call ran
    // inline or was parked. Inline → add it now; the assistant stream
    // renders below it. Queued → do NOT add it here: it would land
    // above the in-flight agent response (streams always render last).
    // The queue panel shows it meanwhile, and when the runner pops it
    // the 'queue:dispatched' event adds the bubble below the previous
    // response, preserving chronological order. The toast tells the
    // user Enter took effect.
    try {
      // REV-AGENT-CORE-006: forward the user's run-mode selection so
      // the adapter can shape argv (Claude `--permission-mode` +
      // `--disallowedTools`).
      const result = await this.api.sendInstruction(
        base,
        text,
        payloads,
        this.state.runMode(key),
        undefined,
        // An additional pane carries its runKey so the run is keyed per-session
        // (and isolate decides whether it runs in its own worktree). The primary
        // pane omits runKey (identity = base, single-pane unchanged). sessionId
        // makes the worktree deterministic so close can clean it up.
        this.runKey()
          ? {
              runKey: key,
              isolate: this.isolate(),
              ...(this.sessionId() ? { sessionId: this.sessionId()! } : {}),
            }
          : undefined,
      );
      if (result?.queued) {
        const pos = result.position ?? 0;
        this.toast.show(this.translate.instant('chat.queued_position', { pos }), {
          kind: 'info',
        });
      } else {
        this.state.addMessage(key, { id: '', role: 'user', text: display });
      }
    } catch (err) {
      console.error('[chat] sendInstruction failed:', err);
      // Send failed outright (neither queued nor running). Surface the
      // user's message anyway so they see what they tried to send.
      this.state.addMessage(key, { id: '', role: 'user', text: display });
    }

    this.attachments.disposePreviews(atts);
  }

  /**
   * S-25 F2.3 — the live `devia_request_review` for this pane, if any.
   *
   * The Cambios view IS the card for this tool: there is no separate widget,
   * the whole diff review is the interaction.
   */
  readonly pendingReview = computed(() =>
    this.uiTools.requestsFor(this.sessionKey()).find((r) => r.tool === 'request_review') ?? null,
  );

  readonly pendingReviewPaths = computed<readonly string[]>(() => {
    const input = this.pendingReview()?.input as { paths?: string[] } | undefined;
    return Array.isArray(input?.paths) ? input.paths : [];
  });

  /** Hands the user's line comments back to the blocked agent. */
  onReviewResolved(prompt: string | null): void {
    const request = this.pendingReview();
    if (!request) return;
    this.uiTools.resolve(
      this.sessionKey(),
      request.callId,
      renderRequestReviewResult(
        prompt ? { decision: 'send', prompt } : { decision: 'cancel' },
      ),
    );
  }

  /**
   * S-28 T-335 — the agent asked for a review of a diff that turned out to be
   * empty. The action bar only exists for a non-empty diff, so answer on the
   * user's behalf rather than leave the agent waiting for its timeout.
   */
  onNothingToReview(): void {
    const request = this.pendingReview();
    if (!request) return;
    this.uiTools.resolve(
      this.sessionKey(),
      request.callId,
      renderRequestReviewResult({ decision: 'empty' }),
    );
    this.view.set('chat');
    this.toast.show(this.translate.instant('diff_viewer.review_nothing'), { kind: 'info' });
  }

  /**
   * S-25 F2.2 — a UI card asked Devia to start a run on the user's behalf.
   *
   * Today only "approve and run" does this. It CANNOT be executed by the run
   * that is still blocked on the tool: the sandbox and permission flags live in
   * the argv of the already-spawned process, so a run started in `plan` can
   * never become `apply` mid-flight. So we switch the session mode and submit;
   * the agent is still busy, which means `submitInstruction` parks this in the
   * queue and the runner dispatches it the moment the current turn ends.
   */
  async runFollowUp(followUp: UiFollowUpRun): Promise<void> {
    const base = this.effectiveProject();
    const key = this.sessionKey();
    if (!base || !key) return;

    this.state.setRunMode(key, followUp.mode);
    try {
      await this.api.sendInstruction(
        base,
        followUp.prompt,
        [],
        followUp.mode,
        followUp.displayText,
        this.runKey()
          ? {
              runKey: key,
              isolate: this.isolate(),
              ...(this.sessionId() ? { sessionId: this.sessionId()! } : {}),
            }
          : undefined,
      );
    } catch (err) {
      console.error('[chat] plan follow-up failed:', err);
      this.toast.show(this.translate.instant('ui_tools.plan.follow_up_failed'), { kind: 'error' });
    }
  }

  async resetSession(): Promise<void> {
    const base = this.effectiveProject();
    const key = this.sessionKey();
    if (!base || !key) return;
    await this.api.resetSession(key);
    await this.state.resetSessionLocal(key, base);
  }

  stopProject(): void {
    const key = this.sessionKey();
    if (key) this.api.stopProject(key);
  }

  // ── Retry (REV-TS-CLI-11-03) ──────────────────────────────────────────

  async retryFromBubble(): Promise<void> {
    const key = this.sessionKey();
    if (!key) return;
    const sent = await this.state.retryLastPrompt(key);
    if (!sent) {
      this.toast.show('No hay instrucción anterior para reintentar.', { kind: 'warning' });
    }
  }

  /**
   * "Continue" on an error bubble: auto-send a localized "an error
   * occurred, continue" exactly as if the user had typed it, so the agent
   * resumes after a quota/API failure without retyping the last prompt.
   */
  continueFromBubble(): void {
    if (!this.effectiveProject() || this.currentRunning()) return;
    this.draft.set(this.translate.instant('message_bubble.continue_after_error_text') as string);
    void this.send();
  }

  // ── Attachments (drag-drop + paste) ───────────────────────────────────

  // For a region to accept native drops we MUST preventDefault on every
  // dragover, even when types is empty — Chromium sometimes withholds
  // dataTransfer.types until the drag enters the drop zone, so the old
  // "only preventDefault for Files" guard silently rejected the first
  // dragover, after which the cursor showed "no-drop" forever.
  onDragOver(e: DragEvent): void {
    if (!e.dataTransfer) return;
    e.preventDefault();
    if (e.dataTransfer.types.includes('Files')) this.dropActive.set(true);
  }

  onDragLeave(e: DragEvent): void {
    if (e.target === e.currentTarget) this.dropActive.set(false);
  }

  onDrop(e: DragEvent): void {
    e.preventDefault();
    this.dropActive.set(false);
    this.attachFiles(Array.from(e.dataTransfer?.files ?? []));
  }

  /** Queue files from drop / paste / picker; oversized ones get a toast. */
  attachFiles(files: readonly File[]): void {
    const rejected = files.filter((f) => this.attachments.add(f, f.name || null) === null);
    if (rejected.length === 0) return;
    this.toast.show(
      this.translate.instant('chat.attachment_too_large', {
        name: rejected.map((f) => f.name || '?').join(', '),
        max: formatBytes(MAX_ATTACHMENT_BYTES),
        total: formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES),
      }),
      { kind: 'warning' },
    );
  }

  // Paste handler must preventDefault when it consumes a file,
  // otherwise the browser also dumps the binary into the textarea as
  // garbled text.
  onPaste(e: ClipboardEvent): void {
    const cd = e.clipboardData;
    if (!cd) return;
    // Try clipboardData.files first (most direct API for file paste
    // in Electron 41+; items iteration was unreliable in some Chromium
    // builds). Fallback: items iteration (covers older clipboard shapes).
    let files = Array.from(cd.files);
    if (files.length === 0) {
      files = Array.from(cd.items)
        .filter((item) => item.kind === 'file')
        .map((item) => item.getAsFile())
        .filter((f): f is File => f !== null);
    }
    const consumed = files.length > 0;
    if (consumed) {
      this.attachFiles(files);
      e.preventDefault();
    }

    // WSL host↔guest clipboard bridge does NOT carry binary image
    // data: when the user copies a screenshot on Windows, the paste
    // event lands with empty text and no files. The user would
    // otherwise assume the feature is broken; the one-shot toast
    // points them at drag-drop or a Linux-side screenshot tool. Shown
    // at most once per session.
    if (!consumed && this.api.isWSL && !this.wslPasteWarned) {
      const txt = (cd.getData('text/plain') ?? '').trim();
      const html = (cd.getData('text/html') ?? '').trim();
      if (!txt && !html && cd.files.length === 0) {
        this.wslPasteWarned = true;
        this.toast.show(this.translate.instant('chat.wsl_clipboard_warning'), {
          kind: 'warning',
          durationMs: 8000,
        });
      }
    }
  }

  // ── Voice ─────────────────────────────────────────────────────────────

  async toggleMic(): Promise<void> {
    if (this.micState() === 'idle') {
      this.recorder = new VoiceRecorder();
      this.micState.set('recording');
      try {
        const pcm = await this.recorder.start();
        this.micState.set('transcribing');
        const result = await this.api.transcribe(pcm.buffer as ArrayBuffer);
        if (result?.text) {
          const cur = this.draft();
          this.draft.set(cur ? `${cur} ${result.text}` : result.text);
          this.inputBar()?.focus();
        } else if (result?.error) {
          console.error('[mic] transcribe error:', result.error);
        }
      } catch (err) {
        console.error('[mic]', err);
      } finally {
        this.micState.set('idle');
        this.recorder = null;
      }
    } else if (this.micState() === 'recording') {
      this.recorder?.stop();
    }
  }
}
