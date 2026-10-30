'use strict';
/**
 * Headless composition of Devia's run pipeline for the agent E2E harness.
 *
 * Mirrors the production wiring (`src-main/features/claude-runner/index.ts` +
 * `src-main/shell/composition-root.ts`) with REAL collaborators — the actual
 * RunInstructionUseCase, launcher, adapter registry and bundled MCP servers —
 * and in-memory fakes only for the stores the renderer owns (config, sessions,
 * state, attachments, outbox). It runs on the compiled main process
 * (`dist/main`, `nx run desktop:build:main`) because the bundled MCP servers
 * resolve `server.js` next to their compiled injector.
 *
 * This is the ONE file to update when the composition changes (S-30 T-347+);
 * the snapshots it produces are the oracle that the change kept behaviour.
 */
const path = require('node:path');

const DIST = path.resolve(__dirname, '../../dist/main');
const req = (rel) => require(path.join(DIST, rel.replace(/^src-main\//, 'main/')));

function loadModules() {
  return {
    RunInstructionUseCase: req('src-main/features/claude-runner/application/run-instruction.use-case.js').RunInstructionUseCase,
    InMemoryProjectRegistry: req('src-main/features/claude-runner/infrastructure/in-memory-project-registry.js').InMemoryProjectRegistry,
    LauncherBackedAgentRunner: req('src-main/features/claude-runner/infrastructure/cli-runner-adapter.js').LauncherBackedAgentRunner,
    ChildProcessCliLauncher: req('src-main/features/cli-adapters/infrastructure/cli-launcher.js').ChildProcessCliLauncher,
    StaticCliAdapterRegistry: req('src-main/features/cli-adapters/infrastructure/registry.js').StaticCliAdapterRegistry,
    MemoryMcpInjector: req('src-main/features/memory/mcp-server/memory-mcp-injector.js').MemoryMcpInjector,
    KanbanMcpInjector: req('src-main/features/sdd/mcp-server/kanban-mcp-injector.js').KanbanMcpInjector,
    UiMcpInjector: req('src-main/features/ui-tools/mcp-server/ui-mcp-injector.js').UiMcpInjector,
    StaticMapperRegistry: req('src-main/features/agents/infrastructure/static-mapper-registry.js').StaticMapperRegistry,
    NativeConfigMcpDelivery: req('src-main/features/agents/shared/native-config-mcp.js').NativeConfigMcpDelivery,
    createHarnessCatalog: req('src-main/features/claude-runner/infrastructure/harness-catalog.js').createHarnessCatalog,
    SkillReader: req('src-main/features/skills/infrastructure/skill-reader.js').SkillReader,
    SubAgentReader: req('src-main/features/sub-agents/infrastructure/sub-agent-reader.js').SubAgentReader,
  };
}

class MemoryConfig {
  constructor(cfg, deviaDir) { this.cfg = cfg; this.dir = deviaDir; }
  get() { return this.cfg; }
  set(partial) { this.cfg = { ...this.cfg, ...partial }; return this.cfg; }
  reload() { return this.cfg; }
  hasWorkspace() { return this.cfg.workspaceRoot.length > 0; }
  configPath() { return path.join(this.dir, 'config.json'); }
  deviaDir() { return this.dir; }
}

/**
 * Session store that keeps the transcript the RENDERER would persist (user turn
 * + assistant text), so `continuity: 'replay'` agents get the same re-seeded
 * history they get in the app.
 */
function createSessionStore() {
  const transcripts = new Map();
  return {
    newSessionId: () => `e2e-${Date.now().toString(36)}`,
    isValidSessionId: (id) => typeof id === 'string' && id.length > 0,
    save() {},
    load: (_project, sessionId) => (transcripts.has(sessionId) ? { messages: transcripts.get(sessionId) } : null),
    list: () => [],
    deleteOne() {},
    deleteProjectSessions() {},
    collectAllStats: () => [],
    /** Harness-only: what the renderer appends after each run. */
    append(sessionId, messages) {
      transcripts.set(sessionId, [...(transcripts.get(sessionId) ?? []), ...messages]);
    },
  };
}

/**
 * The user's MCP-manager servers, settable per scenario (the `harness` one adds
 * a test server) so the other scenarios keep their baseline input.
 */
function createUserServers() {
  let servers = [];
  return {
    enabled: (allowlist) => (allowlist ? servers.filter((s) => allowlist.includes(s.id)) : servers),
    set(next) { servers = next; },
  };
}

/**
 * @param {{ agentId: string, workspaceRoot: string, deviaDir: string, model?: string }} opts
 * @returns {{ useCase: any, registry: any, sessions: ReturnType<typeof createSessionStore>, userServers: ReturnType<typeof createUserServers> }}
 */
function buildHeadlessRun(opts) {
  const m = loadModules();
  const config = new MemoryConfig({
    workspaceRoot: opts.workspaceRoot,
    ignoreFolders: [],
    agentId: opts.agentId,
    agentModels: opts.model ? { [opts.agentId]: { model: opts.model } } : {},
    agentCliEnv: {},
    agentToolPolicy: {},
    memory: { enabled: true, blockExternalMemory: true, engramImported: false },
    remoteControl: { allowShell: false, mirrorDesktop: false, allowFileSend: true, telegram: { enabled: false, botToken: '', chatId: '' } },
    worktreePerSession: false,
  }, opts.deviaDir);
  const deviaDir = () => opts.deviaDir;
  const memory = new m.MemoryMcpInjector(deviaDir);
  const kanban = new m.KanbanMcpInjector(deviaDir);
  const ui = new m.UiMcpInjector();
  const registry = new m.InMemoryProjectRegistry();
  const sessions = createSessionStore();
  const userServers = createUserServers();
  // An empty $HOME: the developer's own global skills must not leak into the
  // snapshots (they would make them machine-specific).
  const emptyHome = path.join(opts.workspaceRoot, '.home');
  const useCase = new m.RunInstructionUseCase({
    config,
    sessions,
    state: { load() {}, save() {} },
    registry,
    runner: new m.LauncherBackedAgentRunner(new m.ChildProcessCliLauncher()),
    agents: new m.StaticCliAdapterRegistry(),
    attachments: {
      save() { throw new Error('unused'); },
      saveAll() { throw new Error('unused'); },
      augmentInstruction: (i) => i,
    },
    outbox: { flush: () => [] },
    tech: { detect: () => 'git' },
    mappers: new m.StaticMapperRegistry({
      nativeMcp: new m.NativeConfigMcpDelivery(),
      enterpriseMcpConfigPresent: () => false,
      // Never touch the developer's real ~/.codex/config.toml from the harness.
      ensureCodexTrust: () => undefined,
    }),
    kanbanMcpServer: (p) => kanban.serverConfig(p),
    memoryMcpServer: (p, a) => memory.serverConfig(p, a),
    uiMcpServer: (dir, tools, harness) => ui.serverConfig(dir, tools, harness),
    mcpServers: userServers,
    harnessCatalog: m.createHarnessCatalog({
      skills: new m.SkillReader(emptyHome),
      subagents: (projectAbs) => new m.SubAgentReader().list(projectAbs),
    }),
  });
  return { useCase, registry, sessions, userServers };
}

module.exports = { buildHeadlessRun };
