import { Injectable, OnDestroy, computed, inject, signal } from '@angular/core';
import { TranslateService } from '@ngx-translate/core';
import { ElectronApiService } from './electron-api.service';
import { ToastService } from './toast.service';
import { applyStyle, applyTheme, resolveStyle, resolveTheme } from '../theme/accent-palettes';
import type {
  DeviaConfig, DeviaConfigView, ProjectEntry, ClaudeOutputEvent, ProcessStartEvent,
  ProcessEndEvent, SessionHandoffEvent, SessionResetEvent,
  OutboxFile, SessionMeta, GitInfoChangedEvent, GitInfo, QuestionAskEvent,
  DiffSnapshotEvent, DetectedAgentView, QueueDispatchedEvent, DiffResult,
} from '../../../types/devia';
import type { RunMode } from '../../features/chat/chat-panel/models/run-mode.model';
import { diffSignature, reconcileComments } from '../../../../shared/domain/review-comment';
import type { ReviewComment, ReviewSide } from '../../../../shared/domain/review-comment';
import type { BranchRef, BranchCheckoutRef } from '../../../../shared/domain/git';
import { getModelContextLength } from '../../../../shared/domain/context-budget';
import { buildSessionStats } from '../../../../shared/domain/session-stats';
import type { SessionStats, StatsSourceMessage, CompactionRecord } from '../../../../shared/domain/session-stats';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { RunId } from '../../../../shared/domain/agent';
import { isForeignEvent } from '../../../../shared/domain/agent';
import type { ChatMessage, ContentBlock, ToolCallRecord } from '../../../../shared/domain/chat';
import { isAskUserTool } from '../../../../shared/domain/question-ask';
import { planRecordText, type PlanRecord, type TodoItem } from '../../../../shared/domain/ui-tools';
import {
  appendAgentEvent,
  isValidEventLog,
  rebuildFromEvents,
} from '../../../../shared/domain/persisted-agent-event';
import { deriveBillingMode } from '../../../../shared/domain/billing';
import type { BillingMode } from '../../../../shared/domain/billing';

// All cross-component state in one place. Components read via signals
// (auto-tracked + OnPush-friendly) and mutate via dedicated methods so the
// data flow stays one-way.

/**
 * Opaque string that uniquely identifies one open session in the renderer's
 * live-state maps.
 *
 * For the single-pane / primary-session case this is the project path
 * (workdir === baseProject), so every existing call site that passes a
 * `projectPath: string` continues to work byte-for-byte without renaming.
 * For additional sessions created by T-150 (git worktrees) it is the worktree
 * directory, which is guaranteed distinct from the base project and from every
 * other concurrent session on the same repo.
 *
 * Formalised here per S-13 T-146.  The shared/domain/session-ref.ts
 * `sessionKey(ref)` function returns this string when a SessionRef is
 * available; call sites that only hold the raw path string already carry the
 * correct value and need not be changed.
 */
type SessionKey = string;

interface PendingTextDelta {
  runId?: RunId;
  text: string;
  cancel: () => void;
}

@Injectable({ providedIn: 'root' })
export class AppStateService implements OnDestroy {
  private readonly api = inject(ElectronApiService);
  private readonly toast = inject(ToastService);
  private readonly translate = inject(TranslateService);

  // ── Config ─────────────────────────────────────────────────────────────
  readonly config = signal<DeviaConfigView | null>(null);
  readonly hasWorkspace = computed(() => !!this.config()?.hasWorkspace);

  // ── Sidebar navigation ─────────────────────────────────────────────────
  readonly navPath  = signal('');
  readonly projects = signal<ProjectEntry[]>([]);

  // ── Selected project + chats ──────────────────────────────────────────
  readonly selectedProject = signal<string | null>(null);
  // chats: SessionKey → ordered messages.
  // Single-session invariant: SessionKey === projectPath (workdir === baseProject).
  // Multi-session (T-150+): SessionKey === worktreeDir, so each pane is isolated.
  readonly chats = signal<Map<SessionKey, ChatMessage[]>>(new Map());
  // Active assistant streams keyed by SessionKey. Multiple sessions can stream
  // in parallel; the chat panel only reads the entry for the currently-selected
  // session key, so switching panes mid-stream never shows another session's bubble.
  // T-149/T-143: when additional-session routing lands, the backend must emit
  // `e.project === worktreeDir` (the SessionKey) for extra sessions so dispatch
  // here routes to the correct map entry without any renderer change.
  readonly assistantStreams = signal<Map<SessionKey, ChatMessage>>(new Map());

  // ── Per-session stats rollup (S-7) ─────────────────────────────────────
  // SessionKey → persisted rollup of the session's ACTIVE run. Seeded at startup
  // from disk, restored on switchSession, recomputed + persisted on every save.
  // The footer reads it at rest so context/cost reflect each session
  // (deterministic across switches, works for non-Claude too).
  readonly sessionStats = signal<Map<SessionKey, SessionStats>>(new Map());

  // ── Docker availability ────────────────────────────────────────────────
  // Probed once at startup (during the splash). Gates the right-rail Docker
  // panel: no `docker compose` on the host → no icon. Re-checked every launch
  // since init() runs on each app start.
  readonly dockerAvailable = signal(false);

  // ── AskUserQuestion (TS-CLI-05) ────────────────────────────────────────
  // When Claude emits an AskUserQuestion tool_use, the main process sends a
  // `question:ask` event that lands here. Components read `pendingQuestions`
  // (keyed by SessionKey) and use the `currentPendingQuestion` computed in
  // the chat panel to display the card for the active session only.
  // REV-TS-CLI-05-04: Map instead of single signal so parallel sessions each
  // keep their own pending question without clobbering each other.
  readonly pendingQuestions = signal<Map<SessionKey, QuestionAskEvent>>(new Map());

  // REV-AGENT-CORE-006 / S-13 T-148: per-session run-mode map.
  // Single-session invariant: the only key in use is selectedProject() (the
  // project path), so callers passing selectedProject() are byte-for-byte
  // equivalent to the previous global signal.
  private readonly _runModes = signal<Map<SessionKey, RunMode>>(new Map());

  /** Returns the run-mode for the given session key; a new session is in 'plan'. */
  runMode(key: SessionKey): RunMode {
    return this._runModes().get(key) ?? 'plan';
  }

  /** Sets the mode locally and tells main, which owns it (Telegram reads it there). */
  setRunMode(key: SessionKey, mode: RunMode): void {
    if (this.runMode(key) === mode) return;
    this.storeRunMode(key, mode);
    void this.api.setRunModeRemote(key, mode);
    // The mode is persisted with the session. An empty chat has no session file
    // yet (a save would create one), so there the mode rides the first save.
    if ((this.chats().get(key)?.length ?? 0) > 0) this.scheduleSave(key);
  }

  /** Applies a restored session's mode (a session saved before the field
   *  existed comes back in plan). Unlike setRunMode it never saves. */
  private restoreRunMode(key: SessionKey, mode: RunMode | undefined): void {
    const next = mode ?? 'plan';
    if (this.runMode(key) === next) return;
    this.storeRunMode(key, next);
    void this.api.setRunModeRemote(key, next);
  }

  private storeRunMode(key: SessionKey, mode: RunMode): void {
    this._runModes.update((prev) => {
      const next = new Map(prev);
      next.set(key, mode);
      return next;
    });
  }

  // ── Last prompt per project (TS-CLI-11) ────────────────────────────────
  // In-memory only — NOT persisted to disk (prompts may contain sensitive info).
  // Stores the most recent user-submitted prompt string per project path so the
  // renderer can offer a one-click "Retry" on failed runs.
  private readonly lastPrompts = new Map<string, string>();

  // ── Diff snapshot grace window (REV-TS-CLI-10-04 / UC-FIX-011) ──────────
  // When process:end arrives the stream is committed to chats. A git:diff-snapshot
  // that arrives within GRACE_MS afterwards is patched into the committed message
  // directly. A periodic sweep removes stale entries; lazy eviction also fires on
  // each onDiffSnapshot call.
  private static readonly GRACE_MS = 10_000;
  private readonly recentlyEnded = new Map<string, { messageId: string; project: string; expiresAt: number }>();
  private recentlyEndedSweepInterval: ReturnType<typeof setInterval> | null = null;

  // ── Per-message event log cap (UC-FIX-010) ────────────────────────────
  // After a run ends, the raw event list is trimmed to the last N so long
  // sessions don't accumulate tens of thousands of objects per message.
  // Committed fields (text, toolCalls, usage) remain authoritative for display.
  private static readonly MAX_EVENTS = 500;

  // ── Git info for the currently focused session's working directory ─────
  // Refreshed: on selectProject, on focusWorkdir, on processEnd, on composeEnd.
  readonly gitInfo = signal<GitInfo | null>(null);

  // S-13 T-143: the working directory the right-rail / statusbar reflect. For
  // a single pane it is the selected project; when a split pane is focused it
  // is that session's worktree dir. `workdir` falls back to selectedProject so
  // single-pane behaviour is unchanged. The git watcher + gitInfo gate on this.
  readonly focusedWorkdir = signal<string | null>(null);
  readonly workdir = computed(() => this.focusedWorkdir() ?? this.selectedProject());

  // S-13 T-155: the live-state key of the FOCUSED pane. Single source of truth
  // for "which session the footer/statusbar/sessions-navbar reflect". For the
  // primary/single pane it is null (everything falls back to selectedProject,
  // so single-pane behaviour is byte-for-byte unchanged); for an additional
  // split pane it is that pane's runKey (= its sessionId, which also matches the
  // SessionMeta.id persisted under the base project by T-156). Set by the
  // ChatPanesContainerComponent on every split/focus/close/project-change.
  readonly focusedSessionKey = signal<string | null>(null);
  // The session key the footer selectors read: the focused pane's key, or the
  // selected project when no split pane is focused.
  readonly focusedKey = computed(() => this.focusedSessionKey() ?? this.selectedProject());
  // True while a footer-triggered sync is in flight, so the button can show
  // a spinner and disable itself. Cleared on resolve regardless of outcome.
  readonly syncingGit = signal(false);

  // True while a footer-triggered branch checkout is in flight (S-22).
  readonly branchSwitching = signal(false);

  // True while a footer-triggered fast-forward pull is in flight (S-22).
  readonly pullingGit = signal(false);

  // ── Cross-component focus signals ─────────────────────────────────────
  // Set by the right-rail file tree when the user clicks a file; the
  // chat-panel reads it via effect to switch to the "Cambios" tab and
  // the diff-viewer scrolls to the matching file. Auto-cleared by the
  // diff-viewer after consumption so re-clicking the same file fires the
  // effect again.
  readonly focusedDiffFile = signal<string | null>(null);

  // ── Sessions for the currently selected project ────────────────────────
  // Populated on selectProject and after a chat save (so newly-created
  // sessions surface in the sidebar dropdown without a manual refresh).
  readonly availableSessions = signal<SessionMeta[]>([]);
  // Monotonic counter incremented on every refreshSessions call so stale
  // IPC responses from a previous project selection are silently discarded.
  private _sessionReqSeq = 0;

  // ── Pinned projects (Fijados section) ──────────────────────────────────
  // Order-preserving list of pinned project paths. Persisted in main's
  // state.json via the pinned:get / pinned:set IPC pair so the section
  // survives app restarts.
  readonly pinnedPaths = signal<string[]>([]);
  // Single source of truth for "which sessions have an agent run in flight".
  // Keyed by SessionKey. Every running indicator (chat Stop button + header
  // chip, statusbar pill, sidebar dots) reads it through isRunning() so they
  // can never disagree. Maintained authoritatively by process:start (add) /
  // process:end (delete), which the renderer receives for every session
  // regardless of selection, and reconciled from listProjects / getPinned
  // snapshots so a renderer reload (dev Ctrl+R) recovers in-flight runs.
  readonly runningPaths = signal<ReadonlySet<SessionKey>>(new Set());
  // Sessions waiting to be continued automatically after the account's usage
  // limit reset: SessionKey → epoch ms of the resume. Driven by main-process
  // autoresume:* events; memory only (a pending resume does not survive a restart).
  readonly autoResumes = signal<ReadonlyMap<SessionKey, number>>(new Map());
  // Cached tech per pinned project. Snapshot from the moment the project
  // was pinned; we refresh it whenever the project appears in this.projects().
  readonly pinnedTech = signal<Map<string, ProjectEntry['tech']>>(new Map());
  // Cached git info per pinned project, refreshed on pin and on processEnd.
  readonly pinnedGit = signal<Map<string, GitInfo | null>>(new Map());

  // ── Splash screen ─────────────────────────────────────────────────────────
  readonly detectedAgents = signal<DetectedAgentView[] | null>(null);
  readonly appReady = signal(false);
  /** S-1: set during the splash scan when an external engram install is
   *  detected (binary on PATH and/or its DB). Drives the post-splash warning
   *  toast when Devia memory is on and the engram block is off. */
  readonly engramInstalled = signal(false);

  // S-13 T-148: per-session composer injection map.
  // Single-session invariant: the only key in use is selectedProject() (the
  // project path), so callers passing selectedProject() are byte-for-byte
  // equivalent to the previous global signal.
  private readonly _composerInjections = signal<Map<SessionKey, string>>(new Map());

  /** Returns the pending injection text for the given session key, or null. */
  composerInjection(key: SessionKey): string | null {
    return this._composerInjections().get(key) ?? null;
  }

  /** Populate the chat composer for a specific session.
   *  The focused-pane routing (T-143) will eventually call this with the
   *  focused pane's session key; for now all callers pass selectedProject(). */
  setComposerDraft(key: SessionKey, text: string): void {
    this._composerInjections.update((prev) => {
      const next = new Map(prev);
      next.set(key, text);
      return next;
    });
  }

  /** Consume-and-clear the pending injection for the given session key. */
  clearComposerInjection(key: SessionKey): void {
    this._composerInjections.update((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Map(prev);
      next.delete(key);
      return next;
    });
  }

  // ── Review comments on the Cambios view (S-1) ─────────────────────────
  // Per-project line comments written in the diff viewer before "Enviar a
  // revisar". Anchored to a diff snapshot via `signature`; when the diff
  // changes underneath (commit/stash/agent edit) reconcileReviewComments
  // prunes anchors that no longer resolve, so the agent never receives a
  // reference to a line that moved or vanished.
  private readonly reviewComments =
    signal<Map<string, { signature: string; comments: ReviewComment[] }>>(new Map());

  getReviewComments(project: string): ReviewComment[] {
    return this.reviewComments().get(project)?.comments ?? [];
  }

  reviewCommentCount(project: string): number {
    return this.getReviewComments(project).length;
  }

  /** Adds or replaces the comment anchored to (filePath, line, side) —
   *  one comment per line. */
  upsertReviewComment(project: string, comment: ReviewComment): void {
    this.reviewComments.update((prev) => {
      const next = new Map(prev);
      const entry = next.get(project) ?? { signature: '', comments: [] };
      const without = entry.comments.filter(
        (c) => !(c.filePath === comment.filePath && c.line === comment.line && c.side === comment.side),
      );
      next.set(project, { signature: entry.signature, comments: [...without, comment] });
      return next;
    });
  }

  removeReviewComment(project: string, filePath: string, line: number, side: ReviewSide): void {
    this.reviewComments.update((prev) => {
      const entry = prev.get(project);
      if (!entry) return prev;
      const next = new Map(prev);
      next.set(project, {
        signature: entry.signature,
        comments: entry.comments.filter(
          (c) => !(c.filePath === filePath && c.line === line && c.side === side),
        ),
      });
      return next;
    });
  }

  clearReviewComments(project: string): void {
    this.reviewComments.update((prev) => {
      if (!prev.has(project)) return prev;
      const next = new Map(prev);
      next.delete(project);
      return next;
    });
  }

  /** Reconciles stored comments against a freshly-fetched diff. No-op when the
   *  diff signature is unchanged. Drops anchors that no longer resolve and
   *  re-anchors the signature. Returns how many were dropped (drives a toast). */
  reconcileReviewComments(project: string, diff: DiffResult): number {
    const entry = this.reviewComments().get(project);
    if (!entry || entry.comments.length === 0) return 0;
    const sig = diffSignature(diff);
    if (sig === entry.signature) return 0;
    const { kept, dropped } = reconcileComments(entry.comments, diff);
    this.reviewComments.update((prev) => {
      const next = new Map(prev);
      if (kept.length === 0) next.delete(project);
      else next.set(project, { signature: sig, comments: kept });
      return next;
    });
    return dropped.length;
  }

  // ── Footer-derived selectors (S-1 T-1) ───────────────────────────────────

  // S-7: at rest the footer reads the active session's persisted rollup so
  // context/cost reflect each session (deterministic across switches, works
  // for non-Claude / pre-capture sessions). While a run streams, the live
  // stream wins; the message scan stays as a final fallback so a project with
  // no rollup yet (first run, tests) still resolves.

  readonly activeModel = computed<string | null>(() => {
    const project = this.focusedKey();
    if (!project) return null;
    const stream = this.assistantStreams().get(project);
    if (stream?.model) return stream.model;
    const snap = this.sessionStats().get(project);
    if (snap?.model) return snap.model;
    const msgs = this.chats().get(project);
    if (msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant' && m.model) return m.model;
      }
    }
    const cfg = this.config();
    if (!cfg) return null;
    return cfg.agentModels[cfg.agentId]?.model ?? null;
  });

  readonly contextUsageTokens = computed<number | null>(() => {
    const project = this.focusedKey();
    if (!project) return null;
    const stream = this.assistantStreams().get(project);
    if (stream?.usage) {
      const { inputTokens, cachedInputTokens } = stream.usage;
      if (inputTokens === undefined && cachedInputTokens === undefined) return null;
      return (inputTokens ?? 0) + (cachedInputTokens ?? 0);
    }
    const snap = this.sessionStats().get(project);
    if (snap?.contextTokens !== undefined) return snap.contextTokens;
    const msgs = this.chats().get(project);
    if (msgs) {
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (m.role === 'assistant' && m.usage?.inputTokens !== undefined) {
          const { inputTokens, cachedInputTokens } = m.usage;
          return (inputTokens ?? 0) + (cachedInputTokens ?? 0);
        }
      }
    }
    return null;
  });

  readonly contextWindowTokens = computed<number | null>(() => {
    // Prefer the window the CLI itself reports for this run — the static
    // table can be off when a model ships with multiple windows under
    // different flags (e.g. Claude Opus 4.7: 200k default / 1M extended).
    const project = this.focusedKey();
    if (project) {
      const stream = this.assistantStreams().get(project);
      if (stream?.usage?.contextWindow !== undefined && stream.usage.contextWindow > 0) {
        return stream.usage.contextWindow;
      }
      const snap = this.sessionStats().get(project);
      if (snap?.contextWindow !== undefined && snap.contextWindow > 0) return snap.contextWindow;
      const msgs = this.chats().get(project);
      if (msgs) {
        for (let i = msgs.length - 1; i >= 0; i--) {
          const w = msgs[i]?.usage?.contextWindow;
          if (typeof w === 'number' && w > 0) return w;
        }
      }
    }
    const cfg = this.config();
    if (!cfg?.agentId) return null;
    return getModelContextLength(cfg.agentId, this.activeModel() ?? undefined);
  });

  readonly contextPct = computed<number | null>(() => {
    const usage = this.contextUsageTokens();
    const windowSize = this.contextWindowTokens();
    if (usage === null || windowSize === null || windowSize === 0) return null;
    const raw = usage / windowSize;
    return Math.round(Math.min(raw, 1.0) * 10000) / 10000;
  });

  /** S-7 T-83: how many times the active session has been compacted. */
  readonly compactionCount = computed<number>(() => {
    const project = this.focusedKey();
    if (!project) return 0;
    return this.sessionStats().get(project)?.compactions.length ?? 0;
  });

  readonly sessionCostUsd = computed<number | null>(() => {
    const project = this.focusedKey();
    if (!project) return null;
    const stream = this.assistantStreams().get(project);
    const snap = this.sessionStats().get(project);
    // At rest the snapshot is the authoritative committed total for the
    // session. While a run streams (or before any rollup exists) sum the
    // committed messages plus the in-flight turn so the figure stays live.
    if (snap && !stream) return snap.costUsd > 0 ? snap.costUsd : null;
    let total = 0;
    let hasAny = false;
    const msgs = this.chats().get(project);
    if (msgs) {
      for (const m of msgs) {
        if (m.role === 'assistant' && m.usage?.costUsd !== undefined && m.usage.costUsd > 0) {
          total += m.usage.costUsd;
          hasAny = true;
        }
      }
    }
    if (stream?.usage?.costUsd !== undefined) {
      total += stream.usage.costUsd;
      hasAny = true;
    }
    if (!hasAny) return null;
    return Math.round(total * 10000) / 10000;
  });

  // S-1 T-4: per-turn cost breakdown for the statusbar cost tooltip. Each
  // completed assistant turn that reported a cost contributes one entry, in
  // chronological order; the in-flight stream (if it already has a cost)
  // tails the list as the current turn. `turn` is the 1-based session turn
  // index so the tooltip can label "Turno 7" even when only the last few are
  // shown. Mirrors `sessionCostUsd`'s sourcing so the sum of the breakdown
  // equals the headline figure.
  readonly sessionCostTurns = computed<readonly { turn: number; costUsd: number }[]>(() => {
    const project = this.focusedKey();
    if (!project) return [];
    const out: { turn: number; costUsd: number }[] = [];
    let turn = 0;
    const msgs = this.chats().get(project);
    if (msgs) {
      for (const m of msgs) {
        if (m.role === 'assistant' && m.usage?.costUsd !== undefined && m.usage.costUsd > 0) {
          out.push({ turn: ++turn, costUsd: m.usage.costUsd });
        }
      }
    }
    const stream = this.assistantStreams().get(project);
    if (stream?.usage?.costUsd !== undefined && stream.usage.costUsd > 0) {
      out.push({ turn: ++turn, costUsd: stream.usage.costUsd });
    }
    return out;
  });

  // S-1 T-2: derived in the renderer (cheaper than re-emitting agents:detected
  // on every Settings env change). Maps DetectedAgentView.authStatus into the
  // BillingAuthStatus shape `deriveBillingMode` expects.
  readonly currentBillingMode = computed<BillingMode>(() => {
    const cfg = this.config();
    if (!cfg) return 'unknown';
    const detected = this.detectedAgents()?.find((a) => a.id === cfg.agentId);
    const authStatus = detected?.authStatus === 'ok'
      ? { kind: 'logged-in' as const }
      : detected?.authStatus === 'missing'
        ? { kind: 'logged-out' as const }
        : { kind: 'unknown' as const };
    return deriveBillingMode(cfg.agentId, cfg.agentCliEnv?.[cfg.agentId], authStatus);
  });

  /** Minimum splash duration ms. Internal — adjust here only. */
  private readonly SPLASH_MIN_MS = 3_000;
  private readonly splashStartMs = Date.now();

  // ── Bootstrap ─────────────────────────────────────────────────────────
  async init() {
    // Body classes drive platform-specific titlebar tweaks. titleBarOverlay
    // (set in main.js) renders the native min/max/close buttons on the right
    // for every OS except macOS — which uses its own traffic lights on the
    // left. So Linux + WSL + Windows all share the same "buttons on the
    // right" layout and need the same fix; only darwin is the odd one out.
    if (this.api.platform === 'darwin') document.body.classList.add('is-macos');
    else document.body.classList.add('is-windows');

    // UC-FIX-011: sweep stale grace-window entries every 5 s so runs without
    // file edits don't accumulate indefinitely.
    this.recentlyEndedSweepInterval = setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.recentlyEnded) {
        if (v.expiresAt <= now) this.recentlyEnded.delete(k);
      }
    }, 5_000);

    const cfg = await this.api.getConfig();
    this.config.set(cfg);

    // Docker probe — fire-and-forget so it never delays the splash. Gates
    // the right-rail Docker panel for this session.
    void this.api.dockerDetect()
      .then((r) => this.dockerAvailable.set(r.available))
      .catch(() => this.dockerAvailable.set(false));
    applyTheme(resolveTheme());
    applyStyle(resolveStyle());

    if (cfg.hasWorkspace) await this.reloadProjects();

    // Hydrate chats from disk so closing/reopening the app doesn't lose
    // conversation history. Each project's active session JSON is loaded
    // and pushed into the chats Map.
    if (cfg.hasWorkspace) await this.hydrateChats();

    // S-7: seed each project's active-session rollup so the footer shows the
    // persisted context/cost of the restored session before any new run.
    if (cfg.hasWorkspace) await this.hydrateSessionStats();

    // Hydrate pinned list before the sidebar renders so the Fijados
    // section doesn't pop in a frame later.
    if (cfg.hasWorkspace) await this.hydratePinned();

    // Reopen the last project the user worked on. Done while the splash
    // is still up so its per-project scan (sub-agents, git, sessions)
    // overlaps the CLI-agent detection — a single startup wait instead
    // of two. Optimistic: a since-deleted path just lands on an empty
    // project, and trashing clears the persisted value.
    if (cfg.hasWorkspace && cfg.lastProjectPath) {
      this.selectProject(cfg.lastProjectPath);
    }

    this.api.onAgentsDetected((e) => {
      this.detectedAgents.set(e.agents);
      const elapsed = Date.now() - this.splashStartMs;
      const remaining = Math.max(0, this.SPLASH_MIN_MS - elapsed);
      setTimeout(() => this.appReady.set(true), remaining);
    });

    // S-1: detect engram alongside the agent scan so the post-splash warning
    // toast (shown by AppComponent) has its answer ready. Best-effort.
    void this.api.detectEngram()
      .then((r) => this.engramInstalled.set(r.present))
      .catch(() => { /* detection is non-fatal */ });

    // Safety fallback: clear splash after 12s even if agents:detected never fires.
    setTimeout(() => { if (!this.appReady()) this.appReady.set(true); }, 12_000);

    this.wireBridgeEvents();
  }

  private async hydratePinned() {
    try {
      const enriched = await this.api.getPinned();
      const entries = Array.isArray(enriched) ? enriched : [];
      // Path order + tech/running caches all come from the same payload so
      // the Fijados row paints the correct icon on the very first render,
      // even for pins whose project is outside the current nav-path view
      // (the previous code only ever populated pinnedTech via
      // syncPinnedFromVisible, which never ran in that case).
      this.pinnedPaths.set(entries.map((e) => e.path));
      const techMap = new Map<string, ProjectEntry['tech']>();
      for (const e of entries) techMap.set(e.path, e.tech);
      this.pinnedTech.set(techMap);
      this.reconcileRunning(entries);

      // Best-effort git info for each pinned project so the subline is not
      // empty on first paint. Parallel, errors swallowed individually.
      const gitEntries = await Promise.all(
        this.pinnedPaths().map(async (p) => {
          try { return [p, await this.api.getGitInfo(p)] as const; }
          catch { return [p, null] as const; }
        }),
      );
      const gitMap = new Map<string, GitInfo | null>();
      for (const [p, info] of gitEntries) gitMap.set(p, info);
      this.pinnedGit.set(gitMap);
    } catch (err) {
      console.error('[pinned] hydrate failed:', err);
    }
  }

  private async hydrateChats() {
    try {
      const loaded = await this.api.loadChats() as Record<string, ChatMessage[]>;
      const map = new Map<string, ChatMessage[]>();
      for (const [projectPath, messages] of Object.entries(loaded ?? {})) {
        if (Array.isArray(messages) && messages.length > 0) {
          // REV-AGENT-CORE-002: when a message carries a valid persisted event
          // log, rebuild the compacted fields from it so the bubble renders
          // deterministically. Falls back to the existing compacted shape
          // when events[] is absent or malformed.
          const hydrated = messages.map(m => this.rehydrateFromEvents(m));
          map.set(projectPath, hydrated);
        }
      }
      this.chats.set(map);
    } catch (err) {
      console.error('[chats] hydrate failed:', err);
    }
  }

  /**
   * If a persisted message carries a valid `events[]`, rebuild the compacted
   * `text` / `thinking` / `toolCalls` / `contentBlocks` / `usage` fields from
   * it. Tolerates malformed event arrays by degrading to the message as-is.
   * REV-AGENT-CORE-002.
   */
  private rehydrateFromEvents(msg: ChatMessage): ChatMessage {
    if (!isValidEventLog(msg.events)) return msg;
    // Skip the rebuild entirely for empty event logs — there's nothing to
    // reconstruct and the caller's compacted fields remain authoritative.
    if (msg.events.length === 0) return msg;
    try {
      const rebuilt = rebuildFromEvents(msg.events);
      // All-or-nothing: when we trust events[] enough to rebuild, every
      // compacted field comes from the rebuild — never mix old + new fields.
      // (Review finding 2 of REV-AGENT-CORE-002.)
      return {
        ...msg,
        text: rebuilt.text,
        thinking: rebuilt.thinking,
        toolCalls: rebuilt.toolCalls,
        contentBlocks: rebuilt.contentBlocks,
        // Usage is the one exception: event logs written before cache tokens
        // and the context window were persisted would otherwise strip them,
        // dropping the footer bar to the static 200k fallback on reload.
        ...(rebuilt.usage !== undefined && { usage: { ...(msg.usage ?? {}), ...rebuilt.usage } }),
      };
    } catch (err) {
      console.warn('[chats] rebuildFromEvents failed; falling back to compacted shape:', err);
      return msg;
    }
  }

  async reloadProjects() {
    const list = await this.api.listProjects(this.navPath());
    this.projects.set(list);
    this.reconcileRunning(list);
    this.syncPinnedFromVisible(list);
  }

  /** Refresh the tech cache for any pinned project that happens to appear in
   *  the just-loaded `list`. Lets the Fijados section render the correct icon
   *  without an extra IPC round-trip. Running state is reconciled separately
   *  via reconcileRunning() into the shared runningPaths signal. */
  private syncPinnedFromVisible(list: ProjectEntry[]) {
    const pinnedSet = new Set(this.pinnedPaths());
    if (pinnedSet.size === 0) return;
    const nextTech = new Map(this.pinnedTech());
    let changed = false;
    for (const e of list) {
      if (!pinnedSet.has(e.path)) continue;
      if (nextTech.get(e.path) !== e.tech) { nextTech.set(e.path, e.tech); changed = true; }
    }
    if (changed) {
      this.pinnedTech.set(nextTech);
    }
  }

  // ── Pinned projects ─────────────────────────────────────────────────────
  /** Append a path to the pinned list (no-op if already pinned). Persists
   *  the new order via IPC; the renderer is the source of truth for order. */
  async pin(entry: ProjectEntry) {
    if (this.pinnedPaths().includes(entry.path)) return;
    const next = [...this.pinnedPaths(), entry.path];
    this.pinnedPaths.set(next);
    // Pre-fill caches so the Fijados row renders fully on the same frame.
    const techMap = new Map(this.pinnedTech());
    techMap.set(entry.path, entry.tech);
    this.pinnedTech.set(techMap);
    this.reconcileRunning([entry]);
    void this.refreshPinnedGit(entry.path);
    try { await this.api.setPinned(next); }
    catch (err) { console.error('[pinned] persist failed:', err); }
  }

  async unpin(projectPath: string) {
    if (!this.pinnedPaths().includes(projectPath)) return;
    const next = this.pinnedPaths().filter((p) => p !== projectPath);
    this.pinnedPaths.set(next);
    try { await this.api.setPinned(next); }
    catch (err) { console.error('[pinned] persist failed:', err); }
  }

  isPinned(projectPath: string): boolean {
    return this.pinnedPaths().includes(projectPath);
  }

  private async refreshPinnedGit(projectPath: string) {
    try {
      const info = await this.api.getGitInfo(projectPath);
      const map = new Map(this.pinnedGit());
      map.set(projectPath, info);
      this.pinnedGit.set(map);
    } catch { /* swallow */ }
  }

  navigateInto(folderPath: string) {
    this.navPath.set(folderPath);
    return this.reloadProjects();
  }

  navigateBack() {
    const cur = this.navPath();
    if (!cur) return Promise.resolve();
    const parent = cur.split('/').slice(0, -1).join('/');
    this.navPath.set(parent);
    return this.reloadProjects();
  }

  /** Bring a project (possibly nested) into view AND select it. Used by
   *  background-finish toasts so a click takes the user straight to the
   *  conversation regardless of where they were navigated to. */
  async navigateToProject(projectPath: string) {
    const lastSlash = projectPath.lastIndexOf('/');
    const parent = lastSlash === -1 ? '' : projectPath.slice(0, lastSlash);
    if (this.navPath() !== parent) {
      this.navPath.set(parent);
      await this.reloadProjects();
    }
    this.selectProject(projectPath);
  }

  selectProject(path: string) {
    this.selectedProject.set(path);
    // Reset the focused working dir to the project itself; the split container
    // re-points it to a pane's worktree when a non-primary pane is focused.
    this.focusedWorkdir.set(path);
    this.gitInfo.set(null);    // clear stale value while we re-fetch
    this.availableSessions.set([]);
    if (!this.chats().has(path)) {
      const next = new Map(this.chats());
      next.set(path, []);
      this.chats.set(next);
    }
    void this.refreshGit(path);
    void this.refreshSessions(path);
    // Reactive watcher: subscribe so external git changes (terminal,
    // remote pull, etc.) flow into gitInfo without a manual refresh.
    void this.api.watchGit(path);
    // Remember where the user is so the next launch reopens here (and
    // runs this project's per-project scan during the splash).
    void this.api.setConfig({ lastProjectPath: path });
  }

  async setWorkspace(path: string) {
    const cfg = await this.api.setConfig({ workspaceRoot: path });
    this.config.set(cfg);
    this.navPath.set('');
    await this.reloadProjects();
  }

  async saveConfig(partial: Partial<DeviaConfig>) {
    const cfg = await this.api.setConfig(partial);
    this.config.set(cfg);
    this.navPath.set('');
    await this.reloadProjects();
  }

  // ── Chat manipulation ─────────────────────────────────────────────────
  // All mutators take a `project` param that IS the SessionKey.
  // For the primary/single session SessionKey === projectPath, so call sites
  // pass projectPath directly — no breakage for existing single-pane code.
  addMessage(project: SessionKey, msg: ChatMessage) {
    if (!msg.id) msg.id = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const map = new Map(this.chats());
    const existing = map.get(project);
    const arr = existing ? [...existing] : [];
    arr.push(msg);
    map.set(project, arr);
    this.chats.set(map);
    this.scheduleSave(project);
    return msg;
  }

  /**
   * S-25 F2.1b — persist the agent's step list into the thread.
   *
   * UPSERT, not append: `devia_todo` sends the COMPLETE list on every call, so
   * appending would bury the conversation under near-identical copies. Exactly
   * one `kind:'todo'` message exists per session and it moves to the end on
   * every update, so it stays next to whatever the agent is doing now.
   */
  upsertTodoMessage(project: SessionKey, items: readonly TodoItem[]): void {
    const map = new Map(this.chats());
    const existing = map.get(project) ?? [];
    const previous = existing.find((m) => m.kind === 'todo');
    const done = items.filter((i) => i.status === 'done').length;
    // A readable rendering also lands in `text` so persistence, rehydration
    // and any text-only consumer keep working untouched.
    const text = `${done}/${items.length} · ${items.map((i) => i.text).join(' · ')}`;
    const message: ChatMessage = {
      id: previous?.id ?? `msg-todo-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      kind: 'todo',
      todo: [...items],
      text,
    };

    map.set(project, [...existing.filter((m) => m.kind !== 'todo'), message]);
    this.chats.set(map);
    this.scheduleSave(project);
  }

  /**
   * S-28 T-337 — keep a decided plan in the thread. Appended, not upserted:
   * every decision is part of the conversation.
   */
  appendPlanMessage(project: SessionKey, record: PlanRecord): void {
    this.addMessage(project, {
      id: `msg-plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      role: 'system',
      kind: 'plan',
      plan: record,
      text: planRecordText(record),
    });
  }

  /** Single read path for "is this session's agent running right now".
   *  `project` is the SessionKey.  Backed by the runningPaths signal so every
   *  consumer reacts together regardless of how many sessions are open. */
  isRunning(project: SessionKey): boolean {
    return this.runningPaths().has(project);
  }

  /**
   * S-2 F0.3: UI guard for loading `sessionId` into the focused destination
   * pane. A switch while the destination's agent is running would corrupt the
   * on-disk history (the in-flight autosave writes the live conversation into
   * the newly chosen session). Single source of truth — the sidebar and the
   * F5 adoption flow both route through here; main adds its own hard guard
   * (SESSION_BUSY, F0.4) for paths that bypass the UI.
   */
  canSwitchSession(sessionId: string): { ok: true } | { ok: false; reason: 'destination-running' } {
    void sessionId; // reserved for finer-grained rules (F5 adoption)
    const destination = this.focusedSessionKey() ?? this.selectedProject();
    if (destination !== null && this.isRunning(destination)) {
      return { ok: false, reason: 'destination-running' };
    }
    return { ok: true };
  }

  /** Replace a message in-place by id (used to finalise streams).
   *  `project` is the SessionKey. */
  private replaceMessage(project: SessionKey, id: string, next: ChatMessage) {
    const map = new Map(this.chats());
    const arr = (map.get(project) ?? []).map((m) => (m.id === id ? next : m));
    map.set(project, arr);
    this.chats.set(map);
    this.scheduleSave(project);
  }

  /** Wipe the in-memory chat for a session (`project` is the SessionKey).
   *  Doesn't touch disk — the next save (or flushSave) writes the now-empty
   *  array under the new session id. */
  clearChat(project: SessionKey) {
    const map = new Map(this.chats());
    map.set(project, []);
    this.chats.set(map);
    // S-7: a reset starts a fresh session — drop the old rollup so the footer
    // doesn't show the previous session's context/cost until the next save.
    const stats = new Map(this.sessionStats());
    if (stats.delete(project)) this.sessionStats.set(stats);
  }

  /** Wipe the visible thread for a reset session: clear the in-memory chat,
   *  drop in a "session reset" system marker, persist immediately so the now
   *  fresh session is written under the new id, and refresh the per-base
   *  session list. Single source of truth for the chat-panel button, the
   *  sidebar action, AND the Telegram `/clean` event so they never drift.
   *  `key` is the SessionKey; `base` is the on-disk base project for the list. */
  async resetSessionLocal(key: SessionKey, base: string) {
    this.clearChat(key);
    // E-DSK-14: the reset kills the in-flight run in the main process. Drop its
    // live stream here too, otherwise the trailing `process:end` would finalise
    // the OLD session's partial reply into the now-fresh thread.
    const streams = new Map(this.assistantStreams());
    if (streams.delete(key)) this.assistantStreams.set(streams);
    this.addMessage(key, {
      id: '',
      role: 'system',
      text: this.translate.instant('chat.session_reset'),
    });
    await this.flushSave(key);
    // The available-sessions list is per base project (on disk).
    await this.refreshSessions(base);
  }

  /** Cancel the debounce timer and write immediately. Used when the user
   *  triggers an action (e.g. reset session) where 500ms of latency would
   *  feel sluggish or risk the next action overwriting the previous state.
   *  `project` is the SessionKey. */
  async flushSave(project: SessionKey) {
    const t = this.saveTimers.get(project);
    if (t) { clearTimeout(t); this.saveTimers.delete(project); }
    const messages = this.chats().get(project) ?? [];
    const stats = this.recomputeSessionStats(project);
    await this.persistChat(project, messages, stats);
  }

  // ── Per-session stats (S-7) ───────────────────────────────────────────

  /** Derive a rollup for `project` from its committed messages, carrying any
   *  prior compaction history forward, and write it into `sessionStats`. */
  private recomputeSessionStats(project: string): SessionStats {
    const stats = this.deriveStatsFromMessages(
      project,
      (this.chats().get(project) ?? []) as unknown as StatsSourceMessage[],
    );
    const next = new Map(this.sessionStats());
    next.set(project, stats);
    this.sessionStats.set(next);
    return stats;
  }

  private deriveStatsFromMessages(project: string, messages: StatsSourceMessage[]): SessionStats {
    const cfg = this.config();
    const prior = this.sessionStats().get(project);
    const fallbackModel = cfg ? cfg.agentModels[cfg.agentId]?.model : undefined;
    return buildSessionStats({
      messages,
      fallbackAgentId: cfg?.agentId ?? 'unknown',
      ...(fallbackModel !== undefined && { fallbackModel }),
      ...(prior?.compactions && prior.compactions.length > 0 && { priorCompactions: prior.compactions }),
      now: Date.now(),
    });
  }

  /** S-7 T-83: append a compaction to the project's rollup. Builds a base
   *  rollup from the current messages if none exists yet, so the record is
   *  never dropped. Persisted on the next save (which carries it forward). */
  private recordCompaction(project: string, trigger?: 'auto' | 'manual', preTokens?: number): void {
    const map = new Map(this.sessionStats());
    const base = map.get(project)
      ?? this.deriveStatsFromMessages(project, (this.chats().get(project) ?? []) as unknown as StatsSourceMessage[]);
    const record: CompactionRecord = {
      at: Date.now(),
      ...(trigger !== undefined && { trigger }),
      ...(preTokens !== undefined && { preTokens }),
    };
    map.set(project, {
      ...base,
      compactions: [...base.compactions, record],
      updatedAt: Date.now(),
    });
    this.sessionStats.set(map);
    this.scheduleSave(project);
  }

  private async hydrateSessionStats() {
    try {
      const loaded = await this.api.loadActiveStats();
      const map = new Map<string, SessionStats>();
      for (const [project, stats] of Object.entries(loaded ?? {})) {
        if (stats) map.set(project, stats);
      }
      this.sessionStats.set(map);
    } catch (err) {
      console.error('[stats] hydrate failed:', err);
    }
  }

  // ── Debounced persistence ─────────────────────────────────────────────
  // Per-project timer so save() collapses bursts of message updates into
  // a single write per ~500ms. Main process holds the activeSessionId and
  // generates one if missing, so we just send a snapshot of the messages.
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingTextDeltas = new Map<string, PendingTextDelta>();

  // S-13 T-156: split-pane persistence redirect. An ADDITIONAL pane keys its
  // live state by a synthetic runKey (a UUID, not a real project path), but its
  // history must be written under the REAL base project with its own session id
  // — otherwise it lands in a synthetic `<UUID>/` folder that `refreshSessions`
  // never lists and a restart orphans it. The pane registers this mapping while
  // mounted; the save path consults it to target `chats:save-as` instead of the
  // default `chats:save`. The primary/single pane never registers, so its
  // SessionKey === projectPath invariant and on-disk layout are untouched.
  private readonly sessionPersistence = new Map<
    SessionKey,
    { baseProject: string; sessionId: string; workdir?: string; worktreeBranch?: string }
  >();

  /** A split pane declares where its history must persist (T-156). The pane's
   *  workdir/branch ride along (S-3 F2.1) so the session file records where it
   *  runs — the restore chain (F2.2) reattaches the worktree from them. */
  registerSessionPersistence(
    sessionKey: SessionKey,
    baseProject: string,
    sessionId: string,
    workdir?: string,
    worktreeBranch?: string,
  ): void {
    this.sessionPersistence.set(sessionKey, {
      baseProject,
      sessionId,
      // Only a REAL worktree is worth persisting — a base-checkout pane has no
      // isolation to restore.
      ...(workdir !== undefined && workdir !== baseProject && { workdir }),
      ...(workdir !== undefined && workdir !== baseProject && worktreeBranch !== undefined && { worktreeBranch }),
    });
  }

  /** A split pane was destroyed/closed — stop redirecting its saves. */
  unregisterSessionPersistence(sessionKey: SessionKey): void {
    this.sessionPersistence.delete(sessionKey);
  }

  /** Persist a session snapshot to the right on-disk location: under its base
   *  project (additional pane, T-156) or under its own key (primary/single). */
  private persistChat(sessionKey: SessionKey, messages: unknown[], stats: SessionStats): Promise<true> {
    const target = this.sessionPersistence.get(sessionKey);
    const runMode = this.runMode(sessionKey);
    return target
      ? this.api.saveChatAs(target.baseProject, target.sessionId, messages, stats, target.workdir, target.worktreeBranch, runMode)
      : this.api.saveChat(sessionKey, messages, stats, runMode);
  }

  private scheduleSave(project: string) {
    const prev = this.saveTimers.get(project);
    if (prev) clearTimeout(prev);
    this.saveTimers.set(project, setTimeout(() => {
      this.saveTimers.delete(project);
      const messages = this.chats().get(project) ?? [];
      const stats = this.recomputeSessionStats(project);
      this.persistChat(project, messages, stats)
        .then(() => {
          // Surface newly-created sessions in the sidebar without manual refresh.
          // For an additional pane the on-disk session lives under its base
          // project, so refresh that project's list when it's the one selected.
          const listFor = this.sessionPersistence.get(project)?.baseProject ?? project;
          if (this.selectedProject() === listFor) void this.refreshSessions(listFor);
        })
        .catch((err) => console.error('[chats] save failed:', err));
    }, 500));
  }

  // UC-FIX-011: clear the sweep interval when the service is destroyed.
  // Root services are never destroyed in production, but this keeps the
  // pattern correct and avoids leaks in test environments.
  ngOnDestroy(): void {
    if (this.recentlyEndedSweepInterval !== null) {
      clearInterval(this.recentlyEndedSweepInterval);
      this.recentlyEndedSweepInterval = null;
    }
    for (const pending of this.pendingTextDeltas.values()) pending.cancel();
    this.pendingTextDeltas.clear();
  }

  // ── Last-prompt store + retry (TS-CLI-11) ─────────────────────────────
  /**
   * Record the most recent prompt submitted for a project. Call this at the
   * point a prompt is sent (before `sendInstruction` IPC) so the retry action
   * always has the text available even if the run never starts.
   *
   * Not persisted to disk — the map is in-memory only.
   */
  storeLastPrompt(project: string, prompt: string): void {
    this.lastPrompts.set(project, prompt);
  }

  /**
   * Re-send the last stored prompt for `project` via `sendInstruction`.
   * Returns `false` (with a toast) when no prompt has been stored yet.
   */
  async retryLastPrompt(project: string): Promise<boolean> {
    const prompt = this.lastPrompts.get(project);
    if (!prompt) {
      this.toast.show('No hay prompt para reintentar', { kind: 'error' });
      return false;
    }
    try {
      await this.api.sendInstruction(project, prompt, []);
      return true;
    } catch (err) {
      console.error('[retryLastPrompt] failed:', err);
      return false;
    }
  }

  // ── AskUserQuestion (TS-CLI-05) ────────────────────────────────────────
  /**
   * Submit the user's answer to a pending AskUserQuestion tool call.
   * Removes the project's entry from `pendingQuestions` optimistically;
   * the main process writes the tool_result to stdin and Claude continues.
   */
  async answerQuestion(project: string, answer: string) {
    const map = this.pendingQuestions();
    const pending = map.get(project);
    if (!pending) return;
    const next = new Map(map);
    next.delete(project);
    this.pendingQuestions.set(next);

    // Reflect the answer on the AskUserQuestion tool call optimistically so
    // the transcript's answered-question card appears at once. Claude later
    // streams the real tool_result (which overwrites this with the same
    // semantics); other agents receive the result on stdin and never echo it
    // back, so this synthetic event is their only record of the answer.
    const stream = this.assistantStreams().get(project);
    if (stream) {
      this.applyAgentEvent(project, stream.runId, {
        type: 'tool_result',
        toolUseId: transcriptQuestionId(stream, pending.toolUseId),
        content: answer,
        isError: false,
      });
    }

    try {
      await this.api.questionAnswer(pending.project, pending.toolUseId, answer);
    } catch (err) {
      console.error('[answerQuestion] failed:', err);
    }
  }

  /** Refresh the available sessions list for a project. */
  async refreshSessions(projectPath: string) {
    if (this.selectedProject() !== projectPath) return;
    const seq = ++this._sessionReqSeq;
    try {
      const list = await this.api.listSessions(projectPath);
      // Discard stale responses: a newer call already superseded this one.
      if (seq !== this._sessionReqSeq) return;
      if (this.selectedProject() === projectPath) this.availableSessions.set(list);
    } catch (err) {
      console.error('[sessions] list failed:', err);
    }
  }

  /** Delete a session entry. If the deleted session was the active one,
   *  the project's in-memory chat is also cleared so the panel reflects the
   *  fact that the next instruction will start a fresh session. */
  async deleteSession(projectPath: string, sessionId: string) {
    const pending = this.saveTimers.get(projectPath);
    if (pending) { clearTimeout(pending); this.saveTimers.delete(projectPath); }

    try {
      const { wasActive } = await this.api.deleteSession(projectPath, sessionId);
      if (wasActive) {
        const map = new Map(this.chats());
        map.set(projectPath, []);
        this.chats.set(map);
      }
      await this.refreshSessions(projectPath);
    } catch (err) {
      console.error('[sessions] delete failed:', err);
      const key = sessionGuardToastKey(err);
      if (key) {
        this.toast.show(this.translate.instant('sidebar.session_delete_blocked_running'), { kind: 'warning' });
        return;
      }
      this.toast.show(
        `No se pudo borrar la sesión: ${(err as Error).message}`,
        { kind: 'error', durationMs: 8000 },
      );
    }
  }

  /** Switch the active session: load its messages, swap into chats, mark
   *  active in main process so the next instruction continues that one. */
  async switchSession(projectPath: string, sessionId: string) {
    // Cancel any pending save so we don't overwrite the chosen session
    // with the previous session's messages.
    const pending = this.saveTimers.get(projectPath);
    if (pending) { clearTimeout(pending); this.saveTimers.delete(projectPath); }

    try {
      const result = await this.api.switchSession(projectPath, sessionId);
      const messages = (result?.messages ?? []) as ChatMessage[];
      // S-7: restore this session's rollup so the footer reflects its context
      // and cost. Prefer the stored snapshot; fall back to deriving it from the
      // just-loaded messages (covers sessions saved before stats existed).
      const restored = result?.stats
        ?? this.deriveStatsFromMessages(projectPath, messages as unknown as StatsSourceMessage[]);
      this.loadSessionIntoKey(projectPath, messages, restored, result?.runMode);
      // Refresh the list so the active marker moves to the new id.
      await this.refreshSessions(projectPath);
    } catch (err) {
      // S-2 F0.4: main rejects with stable codes; map them to i18n toasts.
      // Local state was not touched yet (chats/stats only mutate on success),
      // so the rejected switch leaves the previous session fully consistent.
      console.error('[sessions] switch failed:', err);
      const key = sessionGuardToastKey(err);
      if (key) this.toast.show(this.translate.instant(key), { kind: 'warning' });
    }
  }

  /** Refresh the gitInfo signal for a working directory. Silently noops on
   *  failure. Gated on the focused workdir so split panes update the footer. */
  async refreshGit(projectPath: string) {
    if (this.workdir() !== projectPath) return;
    try {
      const info = await this.api.getGitInfo(projectPath);
      // Guard against races: only update if this is still the focused workdir.
      if (this.workdir() === projectPath) this.gitInfo.set(info);
    } catch {
      this.gitInfo.set(null);
    }
  }

  /** S-13 T-143: point the right-rail / statusbar git at a session's working
   *  directory (a worktree for a split pane, or the project for the primary). */
  focusWorkdir(path: string): void {
    if (this.focusedWorkdir() === path) return;
    this.focusedWorkdir.set(path);
    this.gitInfo.set(null);
    void this.refreshGit(path);
    void this.api.watchGit(path);
  }

  /** S-13 T-155: declare which pane's session the footer / statusbar / sessions
   *  navbar reflect. `null` ⇒ the primary/single pane (fall back to the selected
   *  project). The container calls this alongside `focusWorkdir` so the git
   *  working dir and the live-state key always move together. */
  setFocusedSession(key: string | null): void {
    this.focusedSessionKey.set(key);
  }

  /** S-13 T-157: is this listed session the one the focused pane is showing?
   *  When a split pane is focused the active marker follows its key; otherwise
   *  it defers to the server-computed `isActive` (the project's active session,
   *  i.e. the primary pane). */
  isSessionFocused(session: SessionMeta): boolean {
    const focused = this.focusedSessionKey();
    return focused !== null ? session.id === focused : session.isActive;
  }

  // S-13 T-157: bridge sidebar → split-view container. The container publishes
  // the runKeys of the additional panes it currently mounts; the sidebar uses
  // it to decide whether clicking a listed session should focus an existing
  // pane (session already on screen) rather than reload it into the primary.
  readonly mountedPaneSessions = signal<ReadonlySet<string>>(new Set());
  // A sidebar request to focus the pane showing this session key. The container
  // consumes it via effect and clears it so re-clicking the same session fires
  // again. Null ⇒ nothing pending.
  readonly paneFocusRequest = signal<string | null>(null);

  // S-13 T-158: true when the split view shows more than one pane. The
  // right-rail hides its Terminal tab while a split is active (the terminal runs
  // on the base project, not per-pane, so it's ambiguous with multiple panes).
  readonly splitActive = signal(false);

  /** The container declares whether a split (2+ panes) is currently active. */
  setSplitActive(active: boolean): void {
    this.splitActive.set(active);
  }

  /** The container declares which additional-pane sessions are on screen. */
  setMountedPaneSessions(keys: ReadonlySet<string>): void {
    this.mountedPaneSessions.set(keys);
  }

  /** True when `sessionId` is shown in a live split pane right now. */
  isSessionMounted(sessionId: string): boolean {
    return this.mountedPaneSessions().has(sessionId);
  }

  /** Sidebar asks the container to focus the pane showing this session.
   *  Pass `'primary'` to focus the primary pane (UUID session ids never
   *  collide with that sentinel). */
  requestPaneFocus(sessionId: string): void {
    this.paneFocusRequest.set(sessionId);
  }

  /** Container consumed the request. */
  clearPaneFocusRequest(): void {
    this.paneFocusRequest.set(null);
  }

  // S-2 F5.2: sidebar asks the container to ADOPT a persisted session into the
  // focused additional pane (same request/consume pattern as paneFocusRequest).
  readonly sessionAdoptRequest = signal<string | null>(null);

  requestSessionAdopt(sessionId: string): void {
    this.sessionAdoptRequest.set(sessionId);
  }

  clearSessionAdoptRequest(): void {
    this.sessionAdoptRequest.set(null);
  }

  // S-3 F1.1: the user acknowledged that a pane runs WITHOUT worktree
  // isolation (shared files with the primary). In-memory only and per session
  // key — a restart asks again, which is the conservative default.
  private readonly unisolatedAck = new Set<SessionKey>();

  isUnisolatedAcknowledged(key: SessionKey): boolean {
    return this.unisolatedAck.has(key);
  }

  acknowledgeUnisolated(key: SessionKey): void {
    this.unisolatedAck.add(key);
  }

  /** Load a switched/adopted session's transcript into a live-state key. */
  loadSessionIntoKey(key: SessionKey, messages: ChatMessage[], stats?: SessionStats, runMode?: RunMode): void {
    this.restoreRunMode(key, runMode);
    const map = new Map(this.chats());
    map.set(key, messages);
    this.chats.set(map);
    const statsMap = new Map(this.sessionStats());
    if (stats) statsMap.set(key, stats);
    else statsMap.delete(key);
    this.sessionStats.set(statsMap);
  }

  /** Switch the currently selected project to its default branch and pull.
   *  Surfaces success/failure as a toast. The footer button only renders
   *  when the preconditions hold (non-default branch + clean tree), so the
   *  main process can assume a benign starting state — but it still returns
   *  a structured error if git refuses (e.g. non-fast-forward upstream). */
  async syncGit() {
    const project = this.selectedProject();
    if (!project) return;
    if (this.syncingGit()) return;
    this.syncingGit.set(true);
    try {
      const result = await this.api.syncGit(project);
      if (result.ok) {
        this.toast.show(this.translate.instant('app_state.git_sync_success', { message: result.message }), { kind: 'success' });
      } else {
        this.toast.show(this.translate.instant('app_state.git_sync_error', { message: result.message }), { kind: 'error', durationMs: 8000 });
      }
      // The IPC handler kicks the watcher on success, which will push a
      // fresh gitInfo through onGitInfoChanged. Belt-and-braces refresh
      // here covers the failure case (state may still have changed —
      // e.g. checkout succeeded, pull failed).
      if (this.selectedProject() === project) void this.refreshGit(project);
    } catch (err) {
      this.toast.show(this.translate.instant('app_state.git_sync_failed', { error: (err as Error).message }), { kind: 'error' });
    } finally {
      this.syncingGit.set(false);
    }
  }

  // ── Branch switcher (S-22) ─────────────────────────────────────────────

  /**
   * Fast-forward pull of the CURRENT branch from its upstream, triggered by
   * clicking the footer "behind N" chip. Guards: blocked while an agent runs
   * on the project (its dirty tree would abort the pull anyway). Mirrors
   * syncGit's toast + refresh flow.
   */
  async pullGit(): Promise<boolean> {
    const project = this.selectedProject();
    if (!project) return false;
    if (this.isRunning(project)) {
      this.toast.show(this.translate.instant('app_state.git_pull_blocked_running'), { kind: 'error' });
      return false;
    }
    if (this.pullingGit()) return false;
    this.pullingGit.set(true);
    try {
      const result = await this.api.pullGit(project);
      if (result.ok) {
        this.toast.show(this.translate.instant('app_state.git_pull_success', { message: result.message }), { kind: 'success' });
      } else {
        this.toast.show(this.translate.instant('app_state.git_pull_error', { message: result.message }), { kind: 'error', durationMs: 8000 });
      }
      if (this.selectedProject() === project) void this.refreshGit(project);
      return result.ok;
    } catch (err) {
      this.toast.show(this.translate.instant('app_state.git_pull_failed', { error: (err as Error).message }), { kind: 'error' });
      return false;
    } finally {
      this.pullingGit.set(false);
    }
  }

  /** Lists the base checkout's branches (local + remote). [] with no project. */
  async listBranches(): Promise<BranchRef[]> {
    const project = this.selectedProject();
    if (!project) return [];
    try {
      return await this.api.listBranches(project);
    } catch {
      return [];
    }
  }

  /**
   * Switches the BASE checkout to `ref`. Guards (authoritative): never while a
   * split is active (the worktree protocol forbids base-branch switches) nor
   * while the project's agent runs. Mirrors syncGit's toast + refresh flow.
   */
  async checkoutBranch(ref: BranchCheckoutRef): Promise<boolean> {
    const project = this.selectedProject();
    if (!project) return false;
    if (this.splitActive()) {
      this.toast.show(this.translate.instant('app_state.git_checkout_blocked_split'), { kind: 'error' });
      return false;
    }
    if (this.isRunning(project)) {
      this.toast.show(this.translate.instant('app_state.git_checkout_blocked_running'), { kind: 'error' });
      return false;
    }
    if (this.branchSwitching()) return false;
    this.branchSwitching.set(true);
    try {
      const result = await this.api.checkoutBranch(project, ref);
      if (result.ok) {
        this.toast.show(this.translate.instant('app_state.git_checkout_success', { message: result.message }), { kind: 'success' });
      } else {
        this.toast.show(this.translate.instant('app_state.git_checkout_error', { message: result.message }), { kind: 'error', durationMs: 8000 });
      }
      // The IPC handler kicks the watcher on success; refresh too to cover
      // partial changes (same belt-and-braces as syncGit).
      if (this.selectedProject() === project) void this.refreshGit(project);
      return result.ok;
    } catch (err) {
      this.toast.show(this.translate.instant('app_state.git_checkout_failed', { error: (err as Error).message }), { kind: 'error' });
      return false;
    } finally {
      this.branchSwitching.set(false);
    }
  }

  // ── IPC bridge ────────────────────────────────────────────────────────
  private wireBridgeEvents() {
    this.api.onConfigChanged((cfg) => this.config.set(cfg));
    this.api.onNotificationClick((e) => void this.navigateToProject(e.project));
    // E-DSK-14: Telegram `/use <proyecto>` switches the desktop to that project.
    this.api.onRemoteSelectProject((e) => void this.navigateToProject(e.project));
    // Main owns the run mode: mirror changes made from Telegram (`/mode`, a
    // keyword) or by a session reset, and pick up what is already set on load.
    this.api.onRunModeChanged((e) => this.storeRunMode(e.project as SessionKey, e.mode));
    void this.api.getRunModes().then((all) => {
      for (const e of all) this.storeRunMode(e.project as SessionKey, e.mode);
    });

    // Reactive git updates. Drop events for projects the user has navigated
    // away from — the watcher in main is single-project, but stale events
    // can still arrive during the switch window.
    this.api.onGitInfoChanged((e: GitInfoChangedEvent) => {
      if (e.projectPath === this.workdir()) this.gitInfo.set(e.info);
    });

    // A parked instruction just started running (the runner popped it off
    // the queue). Add its user bubble to the transcript now so it lands
    // below the previous agent response, in chronological order. The
    // inline send path adds its own bubble in ChatPanelComponent.send();
    // this event only fires for items that were queued, so no duplicate.
    this.api.onQueueDispatched((e: QueueDispatchedEvent) => {
      // displayText (when set) is what the user should SEE — system prompts
      // (SDD planner / wake) dispatch internal text the user never typed.
      this.addMessage(e.projectName, { id: '', role: 'user', text: e.displayText ?? e.text });
    });

    // S-2 F3.1: cross-agent handoff. Main emits this BEFORE process:start, so
    // the divider message lands ahead of the run's stream bubble. addMessage
    // schedules the save, making the divider part of the persisted transcript.
    // E-DSK-14: Telegram `/clean` reset the main-process session pointers; the
    // renderer owns the visible thread, so clear it here. The event only fires
    // for the remote path (the chat panel / sidebar clear their own state), so
    // there is no double-clear. `project` is the primary pane's SessionKey,
    // which is also its base project (single-pane / primary), so key === base.
    this.api.onSessionReset((e: SessionResetEvent) =>
      void this.resetSessionLocal(e.project, e.project));

    this.api.onAutoResumeScheduled((e) =>
      this.autoResumes.update((m) => new Map(m).set(e.project, e.fireAt)));
    this.api.onAutoResumeCancelled((e) =>
      this.autoResumes.update((m) => {
        if (!m.has(e.project)) return m;
        const next = new Map(m);
        next.delete(e.project);
        return next;
      }));

    this.api.onSessionHandoff((e: SessionHandoffEvent) => {
      this.addMessage(e.project, {
        id: '',
        role: 'assistant',
        kind: 'handoff',
        handoff: { fromAgentId: e.fromAgentId, toAgentId: e.toAgentId },
        text: e.summary,
      });
    });

    this.api.onProcessStart((e: ProcessStartEvent) => {
      this.markRunning(e.project, true);
      // REV-TS-CLI-05-02: clear any stale pendingQuestion from a previous run
      // before starting a new one so the question card never shows stale state.
      // REV-TS-CLI-05-04: delete from Map rather than null-setting a single signal.
      if (this.pendingQuestions().has(e.project)) {
        const next = new Map(this.pendingQuestions());
        next.delete(e.project);
        this.pendingQuestions.set(next);
      }
      // UC-FIX-002: every stream must carry a runId so the strict event filter
      // works correctly. Main always stamps one; generate a synthetic fallback
      // for older builds or unexpected code paths.
      let streamRunId: RunId | undefined = e.runId;
      if (streamRunId === undefined) {
        streamRunId = crypto.randomUUID() as RunId;
        console.warn('[app-state] ProcessStartEvent missing runId — generated synthetic:', streamRunId);
      }
      const map = new Map(this.assistantStreams());
      map.set(e.project, {
        id: `stream-${e.project}-${Date.now()}`,
        role: 'assistant',
        text: '',
        tools: [],
        streaming: true,
        // REV-AGENT-CORE-001: pin the runId so we can filter incoming events
        // and target cancellation to this specific run.
        runId: streamRunId,
        runStatus: 'running',
        startedAt: Date.now(),
        // Use the agentId stamped by the main process on this specific run.
        // Fallback to the current config to handle older builds without this field.
        agentId: e.agentId ?? this.config()?.agentId,
        // REV-AGENT-CORE-006: stamp the active run mode so the bubble can
        // render a badge and so loaded chats remember the policy used.
        mode: this.runMode(e.project),
        toolCalls: [],
        contentBlocks: [],
        // REV-AGENT-CORE-002: collect the ordered event log so we can persist it
        // and rebuild contentBlocks/toolCalls deterministically on load.
        events: [],
      });
      this.assistantStreams.set(map);
    });

    this.api.onClaudeOutput((e: ClaudeOutputEvent) => this.consumeAgentEvent(e));

    this.api.onProcessEnd((e: ProcessEndEvent) => {
      this.flushPendingTextDelta(e.project);
      this.markRunning(e.project, false);
      const streams = new Map(this.assistantStreams());
      const stream = streams.get(e.project);
      if (stream) {
        // TS-CLI-07: determine final runStatus based on error type.
        // REV-AGENT-CORE-011: a structured `cancelReason` is the authoritative
        // signal — it wins over legacy `error === 'stopped'` / SIGTERM heuristics.
        const hasCancelReason = e.cancelReason !== undefined;
        const isCanceled = hasCancelReason || e.error === 'stopped' || e.signal === 'SIGTERM';
        const isFailed = !!e.error && !isCanceled;
        const runStatus = isCanceled ? 'canceled' : isFailed ? 'failed' : 'succeeded';
        // UC-FIX-010: cap the event log so long-running runs don't accumulate
        // unbounded objects in memory. Committed fields remain authoritative.
        const cappedEvents = (stream.events ?? []).slice(-AppStateService.MAX_EVENTS);
        const finalised: ChatMessage = {
          ...stream,
          streaming: false,
          runStatus,
          endedAt: Date.now(),
          events: cappedEvents,
          ...(e.cancelReason !== undefined && { cancelReason: e.cancelReason }),
        };
        this.addMessage(e.project, finalised);
        streams.delete(e.project);
        this.assistantStreams.set(streams);
        // REV-TS-CLI-10-04 / UC-FIX-011: keep a grace-window reference so a
        // git:diff-snapshot that arrives within GRACE_MS can still be patched in.
        this.recentlyEnded.set(e.project, {
          messageId: finalised.id,
          project: e.project,
          expiresAt: Date.now() + AppStateService.GRACE_MS,
        });
      }
      // E-DSK-09 #262 — quota_exceeded routes through the upgrade toast
      // (ticket #258 listens on `paywall-requested`). The renderer also
      // suppresses the generic error toast in that case so the user only
      // sees the upsell.
      if (e.failoverReason === 'quota_exceeded') {
        window.dispatchEvent(new CustomEvent('paywall-requested', {
          detail: { feature: e.cancelReason ?? 'agent-quota' },
        }));
      }
      if (e.error && e.error !== 'busy' && e.error !== 'stopped' && e.failoverReason !== 'quota_exceeded') {
        // REV-AGENT-CORE-011: structured cancellation gets a humanised label
        // and stamps `cancelReason` on the system message so the bubble can
        // hide the Retry button for user-initiated cancels.
        const cancelText =
          e.cancelReason === 'user' ? 'Cancelado por ti.' :
          e.cancelReason === 'idle' ? 'Cancelado por inactividad (5 min sin salida).' :
          e.cancelReason === 'question_timeout' ? 'Cancelado: no respondiste a la pregunta en 5 minutos.' :
          null;
        // REV-TS-CLI-11-04: classification is stored as a typed field on the
        // message (errorClassification) rather than encoded into the text string.
        // The template reads msg.errorClassification to render a badge / retry UI.
        // Cancellations keep the plain pill (no classification); every other
        // failure defaults to 'unknown' so the error card (Retry/Continue)
        // always renders even when the main process couldn't classify it.
        const classification =
          e.cancelReason !== undefined ? undefined : (e.classification ?? 'unknown');
        this.addMessage(e.project, {
          id: `err-${Date.now()}`,
          role: 'system',
          text: cancelText ?? this.translate.instant('app_state.process_error', { error: e.error }),
          ...(e.cancelReason !== undefined && { cancelReason: e.cancelReason }),
          ...(classification !== undefined && { errorClassification: classification }),
        });
      }
      // REV-TS-CLI-05-02: clear any pending question when the process ends so
      // the question card disappears even if the user never answered it.
      // REV-TS-CLI-05-04: delete from Map rather than null-setting a single signal.
      if (this.pendingQuestions().has(e.project)) {
        const next = new Map(this.pendingQuestions());
        next.delete(e.project);
        this.pendingQuestions.set(next);
      }

      // Toast when a process finishes for a project the user isn't watching.
      // Stops short of being noisy: nothing fires when you're already on the
      // project (you'll see the response land) or for stopped/busy states.
      // Clicking the toast jumps straight to that project's chat.
      if (stream && e.project !== this.selectedProject()
          && e.error !== 'busy' && e.error !== 'stopped') {
        const leaf = e.project.split('/').pop() ?? e.project;
        this.toast.show(this.translate.instant('app_state.process_finished', { project: leaf }), {
          onClick: () => void this.navigateToProject(e.project),
        });
      }
      // Branch/dirty may have shifted as Claude likely touched files.
      if (e.project === this.selectedProject()) void this.refreshGit(e.project);
    });

    // Docker Compose output is rendered by the right-rail Docker panel
    // (DockerStateService), not the chat — so AppStateService no longer
    // subscribes to compose events.

    this.api.onOutboxFile((f: OutboxFile) => {
      this.addMessage(f.project, {
        id: `outbox-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        role: 'outbox',
        name: f.name,
        kind: f.kind,
        path: f.path,
      });
    });

    // AskUserQuestion (TS-CLI-05): store pending question so the chat panel
    // can render an inline question card above the input box.
    // REV-TS-CLI-05-04: insert into Map so parallel projects don't clobber each other.
    this.api.onQuestionAsk((e: QuestionAskEvent) => {
      const current = this.pendingQuestions().get(e.project);
      if (current?.toolUseId === e.toolUseId) return;
      const next = new Map(this.pendingQuestions());
      next.set(e.project, e);
      this.pendingQuestions.set(next);
    });

    // TS-CLI-10: attach diff snapshot to the matching tool call record in the
    // active assistant stream. Non-blocking — the main process fires this after
    // a file-editing tool_result; we just patch the in-memory stream signal.
    // REV-TS-CLI-10-04: also check the grace map for messages that were just
    // committed to chats (process ended before the snapshot arrived).
    this.api.onDiffSnapshot((e: DiffSnapshotEvent) => {
      // Lazily evict expired grace-window entries.
      const now = Date.now();
      for (const [k, v] of this.recentlyEnded) {
        if (v.expiresAt <= now) this.recentlyEnded.delete(k);
      }

      const streams = this.assistantStreams();
      const stream = streams.get(e.project);
      if (stream) {
        // Normal case: process still streaming — patch the live stream.
        const calls = stream.toolCalls ?? [];
        const idx = calls.findIndex((c) => c.id === e.toolCallId);
        if (idx === -1) return;
        const patched = [...calls];
        patched[idx] = { ...patched[idx], diff: e.diff };
        const next = new Map(streams);
        next.set(e.project, { ...stream, toolCalls: patched });
        this.assistantStreams.set(next);
        return;
      }

      // Grace-window case: process ended, patch the committed message in chats.
      const grace = this.recentlyEnded.get(e.project);
      if (!grace) return;
      const chats = new Map(this.chats());
      const msgs = chats.get(e.project);
      if (!msgs) return;
      const msgIdx = msgs.findIndex((m) => m.id === grace.messageId);
      if (msgIdx === -1) return;
      const msg = msgs[msgIdx];
      const calls = msg.toolCalls ?? [];
      const tcIdx = calls.findIndex((c) => c.id === e.toolCallId);
      if (tcIdx === -1) return;
      const patched = [...calls];
      patched[tcIdx] = { ...patched[tcIdx], diff: e.diff };
      const updated = [...msgs];
      updated[msgIdx] = { ...msg, toolCalls: patched };
      chats.set(e.project, updated);
      this.chats.set(chats);
      this.scheduleSave(e.project);
    });
  }

  /**
   * Deserialise a JSON-encoded `AgentEvent` from the IPC transport and
   * update the streaming assistant message for the project.
   *
   * All AgentEvent types are handled here. Types that have no current UI
   * effect (thinking_start, usage, turn_end, raw) are logged at debug
   * level and skipped. Unknown types are logged as a warning; they never
   * throw so future event types survive without a renderer update.
   */
  private consumeAgentEvent(e: ClaudeOutputEvent): void {
    const streams = this.assistantStreams();
    const stream = streams.get(e.project);
    if (!stream) return;

    // REV-AGENT-CORE-001 / UC-FIX-002: strict runId filter.
    // Drop the event if it belongs to a different run or carries no tag when
    // the active stream is tagged (missing tag == stale / untracked event).
    // Legacy streams (runId absent) remain permissive for back-compat.
    if (isForeignEvent(stream.runId, e.runId)) {
      console.warn('[app-state] dropping foreign event', { streamRunId: stream.runId, eventRunId: e.runId });
      return;
    }

    let event: AgentEvent;
    try {
      event = JSON.parse(e.line) as AgentEvent;
    } catch {
      console.warn('[consumeAgentEvent] Failed to parse event line:', e.line);
      return;
    }

    if (event.type === 'text_delta') {
      this.enqueueTextDelta(e.project, e.runId, event.delta);
      return;
    }

    this.flushPendingTextDelta(e.project);
    this.applyAgentEvent(e.project, e.runId, event);
  }

  private enqueueTextDelta(project: string, runId: RunId | undefined, delta: string): void {
    const pending = this.pendingTextDeltas.get(project);
    if (pending && pending.runId === runId) {
      pending.text += delta;
      return;
    }
    if (pending) this.flushPendingTextDelta(project);

    const flush = () => {
      const latest = this.pendingTextDeltas.get(project);
      if (!latest) return;
      this.pendingTextDeltas.delete(project);
      this.applyAgentEvent(project, latest.runId, { type: 'text_delta', delta: latest.text });
    };
    const globals = globalThis as typeof globalThis & {
      requestAnimationFrame?: (callback: FrameRequestCallback) => number;
      cancelAnimationFrame?: (handle: number) => void;
    };
    let cancel: () => void;
    if (typeof globals.requestAnimationFrame === 'function') {
      const handle = globals.requestAnimationFrame(flush);
      cancel = () => globals.cancelAnimationFrame?.(handle);
    } else {
      const handle = setTimeout(flush, 16);
      cancel = () => clearTimeout(handle);
    }
    this.pendingTextDeltas.set(project, { runId, text: delta, cancel });
  }

  private flushPendingTextDelta(project: string): void {
    const pending = this.pendingTextDeltas.get(project);
    if (!pending) return;
    pending.cancel();
    this.pendingTextDeltas.delete(project);
    this.applyAgentEvent(project, pending.runId, { type: 'text_delta', delta: pending.text });
  }

  private applyAgentEvent(project: string, runId: RunId | undefined, event: AgentEvent): void {
    const streams = this.assistantStreams();
    const stream = streams.get(project);
    if (!stream) return;

    if (isForeignEvent(stream.runId, runId)) {
      console.warn('[app-state] dropping foreign event', { streamRunId: stream.runId, eventRunId: runId });
      return;
    }

    const updated = { ...stream };
    let changed = false;
    const duplicateToolUse =
      event.type === 'tool_use' &&
      (updated.toolCalls ?? []).some((call) => call.id === event.id);

    // REV-AGENT-CORE-002: record the event in the persisted log first.
    // appendAgentEvent coalesces text_delta/thinking_delta runs into one entry.
    if (!duplicateToolUse) {
      updated.events = appendAgentEvent(updated.events ?? [], event);
      changed = true;
    }

    switch (event.type) {
      case 'text_delta': {
        updated.text = (updated.text ?? '') + event.delta;
        // Append delta to the last text block, or create a new one.
        const blocks = updated.contentBlocks ? [...updated.contentBlocks] : [];
        const last = blocks[blocks.length - 1];
        if (last?.kind === 'text') {
          blocks[blocks.length - 1] = { kind: 'text', text: last.text + event.delta };
        } else {
          blocks.push({ kind: 'text', text: event.delta });
        }
        updated.contentBlocks = blocks;
        changed = true;
        break;
      }

      case 'tool_use':
        // TS-CLI-07: append a new ToolCallRecord; legacy tools[] kept for
        // the existing template until TS-CLI-08 migrates the bubble.
        if (!updated.tools?.includes(event.name)) {
          updated.tools = [...(updated.tools ?? []), event.name];
        }
        if (!(updated.contentBlocks ?? []).some((block) => block.kind === 'tool_ref' && block.toolCallId === event.id)) {
          updated.contentBlocks = [
            ...(updated.contentBlocks ?? []),
            { kind: 'tool_ref', toolCallId: event.id } satisfies ContentBlock,
          ];
        }
        {
          const calls = updated.toolCalls ?? [];
          const idx = calls.findIndex((call) => call.id === event.id);
          if (idx === -1) {
            updated.toolCalls = [
              ...calls,
              { id: event.id, name: event.name, input: event.input } satisfies ToolCallRecord,
            ];
          } else {
            const patched = [...calls];
            patched[idx] = { ...patched[idx], name: event.name, input: event.input };
            updated.toolCalls = patched;
          }
        }
        changed = true;
        break;

      case 'error':
        // Surface error inline in the stream so the user sees it.
        updated.text = (updated.text ?? '') + `\n[error] ${event.message}`;
        changed = true;
        break;

      case 'status':
        // TS-CLI-07: capture the model name reported in the initialising
        // status event. TS-CLI-08 will surface it in the status bar.
        if (event.model) {
          updated.model = event.model;
          changed = true;
        }
        break;

      case 'thinking_start':
        // TS-CLI-07: initialise the thinking accumulator so thinking_delta
        // can append to it.
        if (updated.thinking === undefined) {
          updated.thinking = '';
          changed = true;
        }
        break;

      case 'thinking_delta':
        // TS-CLI-07: accumulate thinking content. TS-CLI-08 will render it
        // in a collapsible panel.
        updated.thinking = (updated.thinking ?? '') + event.delta;
        changed = true;
        break;

      case 'tool_result': {
        // TS-CLI-07: match the result to the corresponding ToolCallRecord
        // by id and populate its result/isError fields.
        const calls = updated.toolCalls ?? [];
        const idx = calls.findIndex((c) => c.id === event.toolUseId);
        if (idx !== -1) {
          const patched = [...calls];
          patched[idx] = { ...patched[idx], result: event.content, isError: event.isError };
          updated.toolCalls = patched;
          changed = true;
        }
        break;
      }

      case 'usage':
        // TS-CLI-07: store per-turn token usage. TS-CLI-08 will display it.
        // Merge into the existing usage block so a later event that only
        // carries some fields (e.g. the `result` wrapper with costUsd +
        // contextWindow) does not erase the inputTokens / cachedInputTokens
        // already captured from message_start / message_delta.
        updated.usage = {
          ...(updated.usage ?? {}),
          ...(event.inputTokens !== undefined && { inputTokens: event.inputTokens }),
          ...(event.outputTokens !== undefined && { outputTokens: event.outputTokens }),
          ...(event.cachedInputTokens !== undefined && { cachedInputTokens: event.cachedInputTokens }),
          ...(event.reasoningOutputTokens !== undefined && { reasoningOutputTokens: event.reasoningOutputTokens }),
          ...(event.costUsd !== undefined && { costUsd: event.costUsd }),
          ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
          ...(event.contextWindow !== undefined && { contextWindow: event.contextWindow }),
        };
        changed = true;
        break;

      case 'turn_end':
        // The process:end event finalises the stream; nothing to do here.
        break;

      case 'raw':
        // Unrecognised lines from the CLI — log only, do not render.
        console.debug('[consumeAgentEvent] raw line:', event.line);
        break;

      case 'session_started':
        // The agent confirmed its session ID — handled in the main process.
        // The renderer has nothing to render for this event.
        break;

      case 'context_compacted':
        // E-DSK-13 Fase D: memory re-injection happens in the main process.
        // S-7 T-83: record the compaction on the session rollup so the
        // history survives (persisted on the next save, restored on switch).
        this.recordCompaction(project, event.trigger, event.preTokens);
        break;

      case 'rate_limit':
        // The main process schedules the resume; the banner follows the
        // autoresume:* events, so there is nothing to render from this one.
        break;

      default: {
        // TypeScript exhaustive check helper: log and skip unknown future types.
        const _exhaustive: never = event;
        console.warn('[consumeAgentEvent] Unknown event type:', (_exhaustive as AgentEvent).type);
        break;
      }
    }

    if (changed) {
      const next = new Map(streams);
      next.set(project, updated);
      this.assistantStreams.set(next);
    }
  }

  private markRunning(projectPath: string, running: boolean) {
    // Authoritative per-project transition. process:start/end arrive for every
    // project regardless of which one is selected, so this set stays complete
    // without depending on the navPath-filtered projects() list.
    const next = new Set(this.runningPaths());
    if (running) next.add(projectPath); else next.delete(projectPath);
    this.runningPaths.set(next);
    // When a process ends git state likely shifted (commit, branch switch,
    // dirty toggle) — refresh the cached badge for the Fijados subline.
    if (!running && this.pinnedPaths().includes(projectPath)) {
      void this.refreshPinnedGit(projectPath);
    }
  }

  /** Merge an isRunning snapshot (listProjects / getPinned) into runningPaths.
   *  Snapshots can ADD a run we missed (e.g. one the main process started
   *  before this renderer mounted, after a dev reload) and can clear a stale
   *  entry — but never one we're actively streaming locally, since a
   *  mid-run listProjects can lag the registry and process:start/end own
   *  those transitions. */
  private reconcileRunning(entries: readonly { path: string; isRunning: boolean }[]): void {
    const next = new Set(this.runningPaths());
    let changed = false;
    for (const e of entries) {
      const has = next.has(e.path);
      if (e.isRunning && !has) { next.add(e.path); changed = true; }
      else if (!e.isRunning && has && !this.assistantStreams().has(e.path)) {
        next.delete(e.path); changed = true;
      }
    }
    if (changed) this.runningPaths.set(next);
  }
}

/**
 * S-2 F0.4: map the stable guard codes main throws (SESSION_BUSY /
 * SESSION_QUEUE_PENDING) to the sidebar toast keys. IPC rejection messages
 * wrap the original error ("Error invoking remote method …: Error: CODE"),
 * so match by inclusion. Returns null for unrelated errors.
 */
function sessionGuardToastKey(err: unknown): string | null {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('SESSION_QUEUE_PENDING')) return 'sidebar.session_switch_blocked_queue';
  if (message.includes('SESSION_BUSY')) return 'sidebar.session_switch_blocked_running';
  return null;
}

/**
 * The transcript tool call a question answer belongs to. A `devia_ask_user`
 * card is keyed by its rendezvous callId (`ui-<uuid>`), which never matches the
 * stream's `tool_use` id — answering that id recorded nothing, so the decision
 * vanished from the chat unless the agent echoed the result back. Falls back to
 * the latest unanswered question tool of the run.
 */
export function transcriptQuestionId(stream: ChatMessage, toolUseId: string): string {
  const calls = stream.toolCalls ?? [];
  if (!toolUseId.startsWith('ui-') || calls.some((c) => c.id === toolUseId)) return toolUseId;
  for (let i = calls.length - 1; i >= 0; i--) {
    const call = calls[i];
    if (call && isAskUserTool(call.name) && call.result === undefined) return call.id;
  }
  return toolUseId;
}
