import { ipcMain, app, safeStorage, type BrowserWindow } from 'electron';
import * as os from 'os';
import * as path from 'path';
import type { Feature, FeatureContext, SendToRenderer } from '../shared/feature';
import type { RendererEvents } from '../../shared/contracts/events';
import type { StateStore } from '../shared/ports';
import { FileAgentAuditLog } from '../features/security/audit-log';
import {
  HandoffSummariser,
  UnavailableAuxiliaryLLMClient,
  selectAuxiliaryClient,
} from '../features/context-compression';

// Feature factories
import {
  buildWorkspaceFeature,
  FsConfigRepository,
  FsTechDetector,
  FsWorkspaceScanner,
  ListProjectsUseCase,
} from '../features/workspace';
import { buildClaudeRunnerFeature, InMemoryProjectRegistry } from '../features/claude-runner';
import { buildCliAdaptersFeature } from '../features/cli-adapters';
import { purgeOldRawLogs } from '../features/cli-adapters/infrastructure/raw-stream-logger';
import { buildSessionsFeature, FsSessionStore } from '../features/sessions';
import { buildSessionImportFeature } from '../features/session-import';
import { buildSessionStats } from '../../shared/domain/session-stats';
import type { StatsSourceMessage } from '../../shared/domain/session-stats';
import { buildStatusFeature } from '../features/status';
import { buildGitFeature } from '../features/git';
import { buildComposeFeature } from '../features/docker-compose';
import { buildCloneFeature } from '../features/clone';
import { buildVoiceFeature } from '../features/voice';
import {
  buildAttachmentsFeature,
  createAttachmentEnricher,
} from '../features/attachments';
import { buildOutboxFeature, createOutboxFlusher } from '../features/outbox';
import {
  buildPinnedProjectsFeature,
  InMemoryPinnedStore,
} from '../features/pinned-projects';
import { buildShellFeature } from '../features/shell';
import { buildAutoUpdateFeature } from '../features/auto-update';
import { buildQueueFeature } from '../features/queue';
import { buildTerminalFeature } from '../features/terminal';
import { buildSkillsFeature } from '../features/skills';
import { buildProjectTreeFeature } from '../features/project-tree';
import { buildPromptPacksFeature } from '../features/prompt-packs';
import { buildMcpFeature } from '../features/mcp';
import { migrateLegacyMcpPaths } from '../features/mcp/infrastructure/legacy-path-migration';
import { buildSkillRegistryFeature } from '../features/skill-registry';
import { buildSnapshotFeature } from '../features/snapshot';
import { buildSubAgentsFeature, SubAgentReader } from '../features/sub-agents';
import { createHarnessCatalog } from '../features/claude-runner/infrastructure/harness-catalog';
import { buildSddFeature } from '../features/sdd';
import { buildMemoryFeature } from '../features/memory';
import { buildUiToolsFeature } from '../features/ui-tools';
import { enterpriseMcpConfigPresent } from '../features/claude-runner/infrastructure/enterprise-mcp-detector';
import { NativeConfigMcpDelivery, StaticMapperRegistry } from '../features/agents';
import { ensureCodexTrust } from '../shared/codex-defaults';
import { buildContextRecoveryFeature } from '../features/context-recovery';
import {
  buildTelegramControllerFeature,
  createCommandRouter,
  ConfigActiveProjectStore,
  createShellRunner,
} from '../features/telegram-controller';
import { RunGateway } from '../shared/run-gateway';
import { RunModeStore } from '../shared/run-mode-store';
import { seedRunModes } from '../shared/seed-run-modes';
import type { RunMode } from '../../shared/domain/run-capabilities';
import { auditSendFile } from '../shared/outbound-file-gate';
import { AgentTranscriptLogger, purgeOldTranscripts } from '../shared/agent-transcript-logger';
import { createSecretVault, createEmbeddedKeyBackend } from '../shared/secret-vault';

// IPC channels
import { IPC } from '../../shared/contracts/ipc-channels';

// Baked-at-boot constants exposed via the bridge
import { DEVIA_SAAS_URL } from '../config/saas-url';

// Cross-feature persistence
import { FsStateStore } from '../shared/persistence/fs-state-store';

export interface BootstrapOptions {
  getMainWindow(): BrowserWindow | null;
}

export interface BootstrapResult {
  readonly features: readonly Feature[];
  readonly ctx: FeatureContext;
}

/**
 * Composition root.
 *
 * Builds infrastructure singletons in topological order, then wires every
 * feature with the cross-cutting ports it needs. The order is dictated by
 * the dependency graph; the comments mark which feature owns which port.
 *
 * The `features` array assembled at the end is the single seam for future
 * modular monetization: a `LicenseGate` reading from disk/network returns a
 * `Set<FeatureId>` that filters this list before registration.
 */
export function bootstrap(opts: BootstrapOptions): BootstrapResult {
  const send: SendToRenderer = <K extends keyof RendererEvents>(channel: K, payload: RendererEvents[K]) => {
    const win = opts.getMainWindow();
    if (win) win.webContents.send(channel, payload);
  };
  const ctx: FeatureContext = {
    ipc: ipcMain,
    send,
    getMainWindow: opts.getMainWindow,
  };

  // ── Phase 1: cross-cutting singletons. Pure construction; no IPC yet. ────
  // E-DSK-14 #334: seal the Telegram bot token at rest with the OS keychain.
  // Prefer the OS keychain; fall back to an app-embedded AES key so the token
  // is never stored in plaintext on machines without a keychain (e.g. WSL).
  const config       = new FsConfigRepository(createSecretVault(safeStorage, createEmbeddedKeyBackend())); // workspace owns
  const tech         = new FsTechDetector(config);        // workspace owns
  const registry     = new InMemoryProjectRegistry();     // claude-runner owns
  const pinnedStore  = new InMemoryPinnedStore();         // pinned owns
  const sessionStore = new FsSessionStore(config);        // sessions owns
  const runGateway   = new RunGateway();                  // E-DSK-14 (runner ↔ remote)
  const runModes     = new RunModeStore();                // run mode per session, shared app ↔ Telegram

  // Run mode sync. The desktop pushes its changes in; changes that originate in
  // main (Telegram, a session reset) are pushed to the renderer. A desktop
  // change is echoed to the chat so Telegram sees it without asking /status.
  const MODE_NAME: Record<RunMode, string> = { plan: 'Plan', apply: 'Apply', 'apply-yolo': 'YOLO' };
  ipcMain.handle(IPC.runModeSet, (_e, project: string, mode: RunMode) => {
    runModes.set(project, mode, 'desktop');
  });
  ipcMain.handle(IPC.runModeGet, () => runModes.entries());
  runModes.subscribe((project, mode, source) => {
    if (source !== 'desktop') send('runMode:changed', { project, mode });
    else if (config.get().remoteControl.mirrorDesktop === true) {
      telegramBuilt.controller
        .push(`🧭 *[${project.split('/').pop() ?? project}]* Modo → ${MODE_NAME[mode]}`)
        .catch(() => { /* the echo is best-effort */ });
    }
  });

  // Dev-only readable transcript: mirror every run's lifecycle to a Markdown
  // log under <deviaDir>/agent-logs so `npm run dev:all:live` produces a clean,
  // per-session record of "everything the agents answer" (agent + model + full
  // message). Gated on --dev (serve/serve:live pass it) so packaged builds never
  // write it; opt-in elsewhere via DEVIA_AGENT_TRANSCRIPT=1.
  if (process.argv.includes('--dev') || process.env['DEVIA_AGENT_TRANSCRIPT'] === '1') {
    const transcriptDir = path.join(config.deviaDir(), 'agent-logs');
    runGateway.subscribe(
      new AgentTranscriptLogger({
        dir: transcriptDir,
        startedAt: new Date(),
        modelFor: (agentId) => config.get().agentModels[agentId]?.model,
      }).onEvent,
    );
    purgeOldTranscripts({ dir: transcriptDir });
  }
  const attachments  = createAttachmentEnricher(config);  // attachments owns
  const outbox       = createOutboxFlusher(config);       // outbox owns
  // TS-CLI-12 Phase 4: audit log persisted to <userData>/audit.log
  const auditLog     = new FileAgentAuditLog(path.join(app.getPath('userData'), 'audit.log'));

  // ── Phase 2: state store. Aggregates every persisted concern; downstream
  //    use cases call `state.save()` after their mutations. Built before
  //    feature factories so they receive a real reference rather than a
  //    proxy. ──────────────────────────────────────────────────────────────
  const stateStore: StateStore = new FsStateStore({
    config,
    registry,
    pinned: pinnedStore,
    sessions: sessionStore,
  });

  // ── Phase 3: build features with all infra in scope. ─────────────────────
  const gitBuilt = buildGitFeature({ config });

  // S-2 F2.3: background LLM enrichment of the cross-agent handoff brief.
  // The runner's execute() is synchronous, so the summary is precomputed the
  // moment a handoff becomes foreseeable (agent switch / foreign-session
  // switch/adopt) and consumed from this cache with zero added run latency.
  const handoffSummariser = new HandoffSummariser({
    client: () => selectAuxiliaryClient(config.get().agentId),
    clientAvailable: () =>
      !(selectAuxiliaryClient(config.get().agentId) instanceof UnavailableAuxiliaryLLMClient),
  });
  const prepareHandoffIfForeign = (
    identity: string,
    sessionId: string,
    messages: unknown[],
    ownerAgentId: string | null,
  ): void => {
    if (!ownerAgentId || ownerAgentId === config.get().agentId) return;
    handoffSummariser.prepare(identity, sessionId, messages);
  };

  // S-30: one mapper per agent, shared by the runner (how to drive it) and
  // cli-adapters (what the renderer may show it can receive).
  const mappers = new StaticMapperRegistry({
    nativeMcp: new NativeConfigMcpDelivery(),
    ensureCodexTrust,
    enterpriseMcpConfigPresent: () => enterpriseMcpConfigPresent(),
  });
  const cliAdapters = buildCliAdaptersFeature({
    describeHarness: (def) => {
      const mapper = mappers.forDef(def);
      return { ...mapper.harnessSupport, isolatesExternalMcp: mapper.isolatesExternalMcp };
    },
    config,
    // After an agent switch, precompute summaries for every PRIMARY-pane
    // session another agent owns. Pane records key by runKey (a session
    // UUID) whose base project main can't resolve here — skipped; their
    // adopt flow already prepares them.
    onAgentSelected: (newAgentId) => {
      for (const [identityKey, record] of registry.entries()) {
        if (!record.agentSessionAgentId || record.agentSessionAgentId === newAgentId) continue;
        if (!record.activeSessionId) continue;
        if (sessionStore.isValidSessionId(identityKey)) continue; // pane runKey, not a project path
        try {
          const session = sessionStore.load(identityKey, record.activeSessionId);
          if (session && session.messages.length > 0) {
            handoffSummariser.prepare(identityKey, record.activeSessionId, session.messages);
          }
        } catch {
          /* best-effort */
        }
      }
    },
  });
  // REV-AGENT-CORE-003: prompt-packs feature built before the runner so its
  // registry is available when the runner mints its dependencies.
  const promptPacksBuilt = buildPromptPacksFeature({ deviaDir: () => config.deviaDir() });
  // #270: built before MCP + skills so its create use case can be
  // injected into each destructive use case (snapshot before write).
  const snapshotFeature = buildSnapshotFeature({ deviaDir: () => config.deviaDir() });

  // REV-AGENT-CORE-004 + #272: MCP feature. Built early so its
  // registry can inject `--mcp-config` into Claude's argv when servers
  // are enabled, and so it can consume the snapshot capturer for the
  // install/remove flows.
  const mcpBuilt = buildMcpFeature({
    deviaDir: () => config.deviaDir(),
    snapshot: snapshotFeature.create,
  });
  // S-3 T-50: one-shot migration of MCP entries Devia wrote to the
  // wrong path in earlier versions. Moves Devia-managed entries to
  // their correct location (~/.claude.json for Claude global,
  // <project>/opencode.json for OpenCode project,
  // ~/.copilot/mcp-config.json for Copilot global), preserving every
  // hand-edited entry the user added. Best-effort, idempotent.
  try {
    const last = config.get().lastProjectPath;
    const migration = migrateLegacyMcpPaths({
      home: os.homedir(),
      ...(last ? { lastProjectPath: last } : {}),
    });
    if (migration.movedEntries.length > 0) {
      const total = migration.movedEntries.reduce((n, e) => n + e.ids.length, 0);
      console.log(`[mcp:migration] relocated ${total} legacy entr${total === 1 ? 'y' : 'ies'}`);
    }
  } catch (err) {
    console.warn('[mcp:migration] skipped:', (err as Error).message);
  }
  // The queue feature is built before the runner so the runner can
  // attach its dispatcher inside `register()`. The queue's own
  // disk-loaded state is already in memory by the time the runner asks
  // `shouldEnqueue` on the first incoming instruction.
  const queueBuilt = buildQueueFeature({ config, registry });

  // #269: built before the array so we can pass its reader instance
  // (typed as the SkillListReader port) into buildSkillRegistryFeature.
  const subAgentReader = new SubAgentReader();
  const skillsFeature = buildSkillsFeature({
    config,
    snapshot: snapshotFeature.create,
  });

  // E-DSK-12: built before the array so its purger can be injected into
  // the workspace trash use case (clean SDD cache when a project is
  // deleted) without breaking feature isolation.
  const sddBuilt = buildSddFeature({ config });

  // S-1: Devia internal memory + engram integration. Built before the array
  // so its `memoryMcpServer` callback can be handed to the Claude runner
  // (Phase 3b) the same way `sddBuilt.kanbanMcpServer` is.
  const memoryBuilt = buildMemoryFeature({ config });

  // S-24: interactive questions as a Devia MCP tool. Stateless, so it is built
  // here only to hand its per-run callbacks to the Claude runner.
  const uiToolsBuilt = buildUiToolsFeature({ deviaDir: () => config.deviaDir() });

  // E-DSK-13 Fase D: context-recovery tracker. Records when an agent compacts
  // its context mid-run so the runner re-injects Devia's memory on the next run.
  const contextRecoveryBuilt = buildContextRecoveryFeature();

  // E-DSK-14: Telegram remote control. The command router drives instructions
  // through the run gateway (origin 'remote'), so they run in the active
  // project, are mirrored in the app, and the agent's reply streams back to the
  // chat. The active project defaults to the app's last-open project.
  const remoteProjectLister = new ListProjectsUseCase({
    scanner: new FsWorkspaceScanner(config, tech),
    tech,
    projects: registry,
  });
  const remoteShellRunner = createShellRunner(config);
  const telegramBuilt = buildTelegramControllerFeature({
    config,
    onMessage: createCommandRouter({
      gateway: runGateway,
      runModes,
      activeProject: new ConfigActiveProjectStore(config),
      ports: {
        listProjects: (subpath) =>
          remoteProjectLister
            .execute(subpath ?? '')
            .map((p) => ({ path: p.path, name: p.name, runnable: p.tech !== 'folder' })),
        isRunnable: (p) => tech.detect(p) !== 'folder',
        saveAttachment: (payload) => attachments.save(payload).path,
        isRunning: (project) => registry.isRunning(project),
        agentLabel: () => {
          const c = config.get();
          const model = c.agentModels[c.agentId]?.model;
          return model ? `${c.agentId} (${model})` : c.agentId;
        },
        // /status: active project's branch + working-tree state.
        gitInfo: (project) => gitBuilt.exports.inspector.info(project),
        // /status: active session's context-usage + cost rollup (S-7). Reads
        // the persisted rollup; backfills best-effort from messages if absent.
        sessionStats: (project) => {
          const rec = registry.find(project);
          if (!rec?.activeSessionId) return null;
          const session = sessionStore.load(project, rec.activeSessionId);
          if (!session) return null;
          if (session.stats) return session.stats;
          return session.messages.length > 0
            ? buildSessionStats({
                messages: session.messages as StatsSourceMessage[],
                fallbackAgentId: 'unknown',
                now: session.updatedAt,
              })
            : null;
        },
        // /sync: same action as the footer button — checkout default + pull.
        syncGit: (project) => gitBuilt.exports.syncer.sync(project),
        allowShell: () => config.get().remoteControl.allowShell,
        runShell: (project, command) => remoteShellRunner.run(project, command),
      },
      // Desktop → chat mirror: push runs started from the app to Telegram when
      // enabled. `telegramBuilt.controller` resolves lazily at call time (after
      // the feature registers), so the forward reference is safe.
      pushChat: (text) => telegramBuilt.controller.push(text),
      // S-32: a mirrored run's files go to the chat too; every upload is audited.
      pushChatFile: (file) => telegramBuilt.controller.pushFile(file),
      pushChatFiles: (files) => telegramBuilt.controller.pushFiles(files),
      onFileOutcome: (ctx, file, outcome) =>
        auditSendFile(
          auditLog,
          {
            agentId: ctx.agentId ?? config.get().agentId,
            project: ctx.project,
            ...(ctx.runId !== undefined && { runId: ctx.runId }),
          },
          outcome,
          file,
        ),
      mirrorDesktop: () => config.get().remoteControl.mirrorDesktop === true,
      // Telegram `/use <proyecto>` → the renderer switches to that project.
      onActiveProjectChange: (project) => send('remoteControl:select-project', { project }),
    }),
  });

  const features: Feature[] = [
    // S-25 F3.3: read-only catalog + the confirm grants the settings panel manages.
    uiToolsBuilt.feature,
    // Core: always required, never gated.
    buildWorkspaceFeature({
      config, tech,
      projects: registry, sessions: sessionStore, pinned: pinnedStore, state: stateStore,
      sddPurger: sddBuilt.purger,
    }),
    cliAdapters.feature,
    promptPacksBuilt.feature,
    mcpBuilt.feature,
    queueBuilt.feature,
    buildClaudeRunnerFeature({
      mappers,
      config,
      sessions: sessionStore, state: stateStore,
      attachments, outbox, tech, registry,
      agents: cliAdapters.exports.registry,
      launcher: cliAdapters.exports.launcher,
      queue: queueBuilt.service,
      auditLog,
      gitInspector: gitBuilt.exports.inspector,
      ensureSessionWorktree: gitBuilt.exports.ensureSessionWorktree,
      promptPacks: promptPacksBuilt.registry,
      mcpServers: mcpBuilt.registry,
      kanbanMcpServer: sddBuilt.kanbanMcpServer,
      // S-1: Devia internal memory server. How it — like kanban and ui —
      // reaches each agent is that agent's mapper's job (S-30).
      memoryMcpServer: memoryBuilt.memoryMcpServer,
      // S-24: `devia_ask_user` — the question card, now a Devia MCP tool.
      // Keyed by the per-run rendezvous dir, not by project.
      // S-25 F2.6: `devia_notify` reaches the chat relay too. Lazy like
      // `pushChat` below — the controller resolves after its feature registers.
      notifyRemote: (text) => { void telegramBuilt.controller.push(text); },
      isConfirmationGranted: (projectAbs, action) =>
        uiToolsBuilt.confirmations.isGranted(projectAbs, action),
      grantConfirmation: (projectAbs, action, agentId) =>
        uiToolsBuilt.confirmations.grant(projectAbs, action, agentId),
      uiMcpServer: uiToolsBuilt.uiMcpServer,
      // S-30 T-356: skills + sub-agents travel with every run, to any agent.
      harnessCatalog: createHarnessCatalog({
        skills: skillsFeature.reader,
        subagents: (projectAbs) => subAgentReader.list(projectAbs),
      }),
      // E-DSK-13 phase A: recent project memory for system-prompt pre-injection.
      memoryContext: memoryBuilt.memoryContext,
      // E-DSK-13 phase C: passive capture sinks (user prompt + auto summary).
      saveMemoryPrompt: memoryBuilt.saveMemoryPrompt,
      saveMemorySummary: memoryBuilt.saveMemorySummary,
      // S-2 F2.2: cross-agent handoff record (non-auto, standalone entry).
      saveMemoryHandoff: memoryBuilt.saveMemoryHandoff,
      // S-2 F2.3: pre-computed LLM summary (null = deterministic brief).
      handoffSummary: (identity, sessionId) => handoffSummariser.consume(identity, sessionId),
      // S-2 F3.4: rich summary the previous agent recorded on request.
      recentHandoffSummary: memoryBuilt.recentHandoffSummary,
      // S-2 F3.1: forward the handoff to the renderer (emitted before
      // process:start so the divider lands ahead of the run's stream).
      onSessionHandoff: (e) => send('session:handoff', e),
      // E-DSK-13 #313: per-agent memory-tool capability (gates the protocol).
      // E-DSK-13 #322: detect third-party memory MCPs for a coexistence warning.
      detectExternalMemory: memoryBuilt.detectExternalMemory,
      // E-DSK-13 Fase D: re-inject memory after the agent compacts its context.
      markContextCompacted: contextRecoveryBuilt.markContextCompacted,
      consumeMemoryReinjection: contextRecoveryBuilt.consumeMemoryReinjection,
      // E-DSK-14: bind the queue-aware submit + republish run events so the
      // Telegram controller can drive and mirror runs.
      runGateway,
      // A reset session starts over in plan mode.
      onSessionReset: (project) => runModes.reset(project),
      // S-32: `devia_send_file` is only offered while the relay is connected.
      // The controller resolves lazily (after its feature registers).
      remoteRelayConnected: () => {
        try {
          return telegramBuilt.controller.getStatus().state === 'connected';
        } catch {
          return false;
        }
      },
      isLiveSessionWorktree: gitBuilt.exports.isLiveSessionWorktree,
    }),
    buildSessionsFeature({
      registry,
      sessions: sessionStore,
      state: stateStore,
      // S-2 F0.4: a switch with parked items would dispatch them into the
      // newly chosen session — sessions consults the queue through this port.
      queue: { pendingCount: (identity) => queueBuilt.service.view(identity).items.length },
      // S-2 F2.3: precompute the handoff summary when a foreign-owned session
      // is loaded (switch/adopt) while a different agent is active.
      prepareHandoff: prepareHandoffIfForeign,
      // S-3 F2.2: adopt recovery chain — validate/recreate session worktrees.
      worktrees: {
        isLive: gitBuilt.exports.isLiveSessionWorktree,
        recreate: gitBuilt.exports.reattachSessionWorktree,
        cleanup: gitBuilt.exports.cleanupSessionWorktree,
      },
    }),
    // S-20 (generalises S-18): import pre-existing CLI-agent sessions into Devia.
    buildSessionImportFeature({ config, sessions: sessionStore }),
    buildStatusFeature({ registry, git: gitBuilt.exports.inspector }),
    buildShellFeature({ config }),
    buildAutoUpdateFeature(),
    buildOutboxFeature(),
    buildAttachmentsFeature(),
    buildTerminalFeature({ config }),
    snapshotFeature,
    skillsFeature,
    buildSkillRegistryFeature({ reader: skillsFeature.reader }),
    // #275: cross-CLI sub-agent manager. Consumes the SnapshotCapturer
    // port from #270 so install/remove offer the same "Deshacer" flow.
    buildSubAgentsFeature({ config, snapshot: snapshotFeature.create }),
    // E-DSK-12: devia-native SDD — first-contact bootstrap, kanban
    // board, cross-process MCP server, notifications, commit mapping.
    sddBuilt.feature,
    // S-1: Devia internal memory + engram integration.
    memoryBuilt.feature,

    // Modules: candidates for license gating later.
    gitBuilt.feature,
    buildProjectTreeFeature({ config }).feature,
    buildComposeFeature({ config }),
    buildCloneFeature({ config }),
    buildVoiceFeature(),
    buildPinnedProjectsFeature({ registry, state: stateStore, tech, store: pinnedStore }),
    // E-DSK-14: Telegram remote control.
    telegramBuilt.feature,
  ];

  // Bridge-level constants exposed without a dedicated feature — the saas
  // baseUrl is a baked-at-boot string the renderer reads through the bridge
  // (ticket #251). Lives here because there's no other state to wire around
  // it and a full feature would be ceremonial.
  ctx.ipc.handle(IPC.saasBaseUrl, () => DEVIA_SAAS_URL);

  // The running app version (synced to the release tag at build time). Read by
  // the statusbar so the footer matches the published/downloads-page version.
  ctx.ipc.handle(IPC.appVersion, () => app.getVersion());

  // ── Phase 4: hydrate persisted state, then register IPC handlers. ────────
  stateStore.load();
  // Put each project back in the run mode its active session was left in.
  seedRunModes(registry, sessionStore, runModes);
  for (const feature of features) feature.register(ctx);

  // Housekeeping: evict raw CLI logs (T-76) older than the retention window.
  // Fire-and-forget — purge errors are swallowed inside the helper.
  purgeOldRawLogs();

  return { features, ctx };
}

export function beforeQuit(installed: readonly Feature[]): void {
  for (const feature of installed) feature.onBeforeQuit?.();
}
