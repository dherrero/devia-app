import { contextBridge, ipcRenderer } from 'electron';
import type { DeviaBridge } from '../../shared/contracts/devia-bridge';

/**
 * Implementation of the `DeviaBridge` contract.
 *
 * **Sandboxed preload constraint** — since Electron 20+ the preload runs in a
 * sandboxed renderer where `require()` only resolves Electron built-ins. We
 * cannot import the `IPC` channel-name registry from `shared/contracts/`
 * because that would be a project-file require and Chromium's sandbox blocks
 * it. The channel strings are therefore inlined here. They MUST stay in sync
 * with `shared/contracts/ipc-channels.ts`, which is the source of truth for
 * the main-process side (every feature's IPC adapter imports from there). The
 * `DeviaBridge` type import is type-only and erased at compile time, so the
 * preload's runtime requires reduce to a single `electron` import.
 *
 * The alternative — bundling the preload with esbuild/rollup — is the
 * "proper" long-term fix and worth doing once we add a build tool to the main
 * process pipeline. Until then this duplication is the smaller evil.
 */
const bridge: DeviaBridge = {
  platform: process.platform,
  // WSL_DISTRO_NAME is exported by wslg/WSL2 to every Linux process; checking
  // it from the sandboxed preload avoids needing fs to read /proc/version.
  isWSL: process.platform === 'linux' && !!process.env['WSL_DISTRO_NAME'],

  // Workspace + config
  listProjects:   (subpath)               => ipcRenderer.invoke('projects:list', subpath ?? ''),
  searchProjects: (query)                 => ipcRenderer.invoke('projects:search', query ?? ''),
  newProject:     (name, parent)          => ipcRenderer.invoke('project:new', name, parent ?? ''),
  newFolder:      (name, parent)          => ipcRenderer.invoke('folder:new', name, parent ?? ''),
  renameFolder:   (folderPath, newName)   => ipcRenderer.invoke('folder:rename', folderPath, newName),
  moveProject:    (sourcePath, targetFolder) => ipcRenderer.invoke('project:move', sourcePath, targetFolder),
  listBases:      ()                      => ipcRenderer.invoke('bases:list'),
  readBasesJson:  ()                      => ipcRenderer.invoke('bases:read-json'),
  writeBasesJson: (text)                  => ipcRenderer.invoke('bases:write-json', text),
  newFromBase:    (base, name, parent)    => ipcRenderer.invoke('project:new-base', base, name, parent ?? ''),
  trashProject:   (projectPath)           => ipcRenderer.invoke('project:trash', projectPath),
  getConfig:      ()                      => ipcRenderer.invoke('config:get'),
  setConfig:      (partial)               => ipcRenderer.invoke('config:set', partial),
  pickFolder:     (opts)                  => ipcRenderer.invoke('dialog:pickFolder', opts),
  pickFile:       (opts)                  => ipcRenderer.invoke('dialog:pickFile', opts),

  // Sessions
  loadChats:        ()                            => ipcRenderer.invoke('chats:loadAll'),
  loadActiveStats:  ()                            => ipcRenderer.invoke('sessions:active-stats'),
  aggregateStats:   ()                            => ipcRenderer.invoke('stats:aggregate'),
  saveChat:         (projectPath, messages, stats) => ipcRenderer.invoke('chats:save', projectPath, messages, stats),
  saveChatAs:       (baseProject, sessionId, messages, stats, workdir, worktreeBranch) => ipcRenderer.invoke('chats:save-as', baseProject, sessionId, messages, stats, workdir, worktreeBranch),
  listSessions:     (projectPath)                 => ipcRenderer.invoke('sessions:list', projectPath),
  switchSession:    (projectPath, sId)            => ipcRenderer.invoke('session:switch', projectPath, sId),
  adoptSession:     (baseProject, runKey, sId)    => ipcRenderer.invoke('session:adopt', baseProject, runKey, sId),
  deleteSession:    (projectPath, sId)            => ipcRenderer.invoke('session:delete', projectPath, sId),
  scanSessionImport: ()                           => ipcRenderer.invoke('session-import:scan'),
  runSessionImport:  (selections, opts)           => ipcRenderer.invoke('session-import:run', selections, opts),

  // Claude runner
  sendInstruction:(project, text, atts, mode, displayText, runOpts) => ipcRenderer.invoke('instruction:send', project, text, atts ?? [], mode, displayText, runOpts),
  stopProject:    (project)               => ipcRenderer.invoke('process:stop', project),
  resetSession:   (project)               => ipcRenderer.invoke('session:reset', project),
  cancelAutoResume: (project)             => ipcRenderer.invoke('autoresume:cancel', project),
  stopAll:        ()                      => ipcRenderer.invoke('process:stop-all'),
  // REV-AGENT-CORE-001: cancel a specific run by id.
  cancelRun:      (runId)                 => ipcRenderer.invoke('run:cancel', runId),
  // REV-AGENT-CORE-003: prompt-pack discovery.
  listPromptPacks: ()                     => ipcRenderer.invoke('promptPacks:list'),
  rescanPromptPacks: ()                   => ipcRenderer.invoke('promptPacks:rescan'),

  // Per-project queue
  listQueue:      (project)               => ipcRenderer.invoke('queue:list', project),
  addToQueue:     (project, text)         => ipcRenderer.invoke('queue:add', project, text),
  removeFromQueue:(project, id)           => ipcRenderer.invoke('queue:remove', project, id),
  editInQueue:    (project, id, text)     => ipcRenderer.invoke('queue:edit', project, id, text),
  moveInQueue:    (project, id, newIndex) => ipcRenderer.invoke('queue:move', project, id, newIndex),
  clearQueue:     (project)               => ipcRenderer.invoke('queue:clear', project),
  pauseQueue:     (project)               => ipcRenderer.invoke('queue:pause', project),
  resumeQueue:    (project)               => ipcRenderer.invoke('queue:resume', project),

  // Status + pinned
  getStatus:      ()                      => ipcRenderer.invoke('status:get'),
  getPinned:      ()                      => ipcRenderer.invoke('pinned:get'),
  setPinned:      (paths)                 => ipcRenderer.invoke('pinned:set', paths),

  // Git
  getGitInfo:     (projectPath)           => ipcRenderer.invoke('git:info', projectPath),
  watchGit:       (projectPath)           => ipcRenderer.invoke('git:watch', projectPath),
  getGitDiff:     (projectPath)           => ipcRenderer.invoke('git:diff', projectPath),
  syncGit:        (projectPath)           => ipcRenderer.invoke('git:sync', projectPath),
  pullGit:        (projectPath)           => ipcRenderer.invoke('git:pull', projectPath),
  listBranches:   (projectPath)           => ipcRenderer.invoke('git:list-branches', projectPath),
  checkoutBranch: (projectPath, ref)      => ipcRenderer.invoke('git:checkout', projectPath, ref),
  addWorktree:    (baseProject, sessionId) => ipcRenderer.invoke('git:worktree-add', baseProject, sessionId),
  removeWorktree: (baseProject, sessionId) => ipcRenderer.invoke('git:worktree-remove', baseProject, sessionId),
  cleanupWorktree:(baseProject, sessionId) => ipcRenderer.invoke('git:worktree-cleanup', baseProject, sessionId),
  listWorktrees:  (baseProject)           => ipcRenderer.invoke('git:worktree-list', baseProject),

  // Project tree
  listProjectTree:(project, subPath, force) => ipcRenderer.invoke('projectTree:list', project, subPath ?? '', !!force),

  // Compose + clone
  runCompose:     (project, action, composeFile) => ipcRenderer.send('compose:run', project, action, composeFile),
  dockerDetect:   ()                      => ipcRenderer.invoke('docker:detect'),
  composeDetect:  (project)               => ipcRenderer.invoke('compose:detect', project),
  composeSearch:  (project)               => ipcRenderer.invoke('compose:search', project),
  cloneRepo:      (payload)               => ipcRenderer.send('clone:run', payload),

  // Shell
  openPath:       (p)                     => ipcRenderer.invoke('shell:openPath', p),
  revealInFolder: (p)                     => ipcRenderer.invoke('shell:reveal', p),
  openInIde:      (p, ideId)              => ipcRenderer.invoke('shell:openInIde', p, ideId),
  listIdes:       ()                      => ipcRenderer.invoke('shell:listIdes'),
  openUpgrade:    (feature)               => ipcRenderer.invoke('shell:open-upgrade', feature),

  // Titlebar / custom window controls
  minimizeWindow:     ()                  => ipcRenderer.invoke('window:minimize'),
  toggleMaximizeWindow: ()                => ipcRenderer.invoke('window:toggle-maximize'),
  closeWindow:        ()                  => ipcRenderer.invoke('window:close'),
  isWindowMaximized:  ()                  => ipcRenderer.invoke('window:is-maximized'),

  // Voice
  transcribe:     (buffer)                => ipcRenderer.invoke('voice:transcribe', buffer),

  // Integrated terminal
  terminalStart:  (project, size)         => ipcRenderer.invoke('terminal:start', project, size),
  terminalWrite:  (project, data)         => ipcRenderer.send('terminal:write', project, data),
  terminalResize: (project, size)         => ipcRenderer.send('terminal:resize', project, size),
  terminalStop:   (project)               => ipcRenderer.invoke('terminal:stop', project),

  // Skills manager
  listSkills:           (project)         => ipcRenderer.invoke('skills:list', project),
  installSkills:        (req)             => ipcRenderer.invoke('skills:install', req),
  removeSkill:          (req)             => ipcRenderer.invoke('skills:remove', req),
  discoverSkills:       (req)             => ipcRenderer.invoke('skills:discover', req),
  cancelSkillDiscovery: (id)              => ipcRenderer.invoke('skills:cancel-discovery', id),

  // CLI adapters
  listAgents:     ()                      => ipcRenderer.invoke('agents:list'),
  selectAgent:    (agentId)               => ipcRenderer.invoke('agent:select', agentId),
  setAgentModel:  (input)                 => ipcRenderer.invoke('agent:setModel', input),
  setAgentEnv:    (input)                 => ipcRenderer.invoke('agent:setEnv', input),
  testAgent:      (agentId)               => ipcRenderer.invoke('agent:test', agentId),

  // Event subscriptions — listeners live for the lifetime of the app; the
  // renderer keeps a singleton wrapper around these, no removal needed.
  onClaudeOutput:   (cb) => { ipcRenderer.on('claude:output',     (_e, d) => cb(d)); },
  onProcessStart:   (cb) => { ipcRenderer.on('process:start',     (_e, d) => cb(d)); },
  onSessionHandoff: (cb) => { ipcRenderer.on('session:handoff',   (_e, d) => cb(d)); },
  onSessionReset:   (cb) => { ipcRenderer.on('session:reset',      (_e, d) => cb(d)); },
  onAutoResumeScheduled: (cb) => { ipcRenderer.on('autoresume:scheduled', (_e, d) => cb(d)); },
  onAutoResumeCancelled: (cb) => { ipcRenderer.on('autoresume:cancelled', (_e, d) => cb(d)); },
  onProcessEnd:     (cb) => { ipcRenderer.on('process:end',       (_e, d) => cb(d)); },
  onComposeStart:   (cb) => { ipcRenderer.on('compose:start',     (_e, d) => cb(d)); },
  onComposeOutput:  (cb) => { ipcRenderer.on('compose:output',    (_e, d) => cb(d)); },
  onComposeEnd:     (cb) => { ipcRenderer.on('compose:end',       (_e, d) => cb(d)); },
  onOutboxFile:     (cb) => { ipcRenderer.on('outbox:file',       (_e, d) => cb(d)); },
  onCloneStart:     (cb) => { ipcRenderer.on('clone:start',       (_e, d) => cb(d)); },
  onCloneOutput:    (cb) => { ipcRenderer.on('clone:output',      (_e, d) => cb(d)); },
  onCloneEnd:       (cb) => { ipcRenderer.on('clone:end',         (_e, d) => cb(d)); },
  onGitInfoChanged: (cb) => { ipcRenderer.on('git:info-changed',  (_e, d) => cb(d)); },
  onConfigChanged:  (cb) => { ipcRenderer.on('config:changed',    (_e, d) => cb(d)); },
  onNotificationClick: (cb) => { ipcRenderer.on('notification:click', (_e, d) => cb(d)); },
  onAgentChanged:   (cb) => { ipcRenderer.on('agent:changed',     (_e, d) => cb(d)); },
  onQueueChanged:   (cb) => { ipcRenderer.on('queue:changed',     (_e, d) => cb(d)); },
  onQueueDispatched: (cb) => { ipcRenderer.on('queue:dispatched', (_e, d) => cb(d)); },
  onTerminalData:   (cb) => { ipcRenderer.on('terminal:data',     (_e, d) => cb(d)); },
  onTerminalExit:   (cb) => { ipcRenderer.on('terminal:exit',     (_e, d) => cb(d)); },

  // AskUserQuestion multi-turn protocol (TS-CLI-05)
  onQuestionAsk:    (cb) => { ipcRenderer.on('question:ask',      (_e, d) => cb(d)); },
  questionAnswer:   (project, toolUseId, answer) =>
    ipcRenderer.invoke('question:answer', project, toolUseId, answer),

  // devia-ui interface tools (S-25)
  onUiToolRequest:  (cb) => { ipcRenderer.on('ui:tool-request',   (_e, d) => cb(d)); },
  sendUiToolResult: (project, callId, answer) =>
    ipcRenderer.invoke('ui:tool-result', project, callId, answer),
  listUiToolCatalog: () => ipcRenderer.invoke('uiTools:catalog'),
  listUiToolGrants: (project) => ipcRenderer.invoke('uiTools:grants', project),
  revokeUiToolGrant: (project, action) => ipcRenderer.invoke('uiTools:revoke', project, action),

  // Security audit log (TS-CLI-12 Phase 4)
  readAuditLog:     (n) => ipcRenderer.invoke('audit:read', n),

  // Inline diff snapshots for file-editing tool results (TS-CLI-10)
  onDiffSnapshot:   (cb) => { ipcRenderer.on('git:diff-snapshot', (_e, d) => cb(d)); },

  // Agent detection push — main process fires this once after startup probing.
  onAgentsDetected: (cb) => { ipcRenderer.on('agents:detected',   (_e, d) => cb(d)); },

  getAppVersion: () => ipcRenderer.invoke('app:version'),

  // Devia SaaS — baked-at-boot baseUrl resolved by the main process. The
  // renderer caches the first response in-process; the value is stable for
  // the lifetime of the app (ticket #251).
  saas: {
    baseUrl: () => ipcRenderer.invoke('saas:baseUrl'),
  },

  // Skill registry (#269) — per-project .devia/skill-registry.md index.
  skillRegistry: {
    status:  (projectPath) => ipcRenderer.invoke('skillRegistry:status', projectPath),
    refresh: (projectPath) => ipcRenderer.invoke('skillRegistry:refresh', projectPath),
    watch:   (projectPath) => ipcRenderer.invoke('skillRegistry:watch', projectPath),
    onChanged: (cb) => { ipcRenderer.on('skillRegistry:changed', (_e, d) => cb(d)); },
    read:    (projectPath) => ipcRenderer.invoke('skillRegistry:read', projectPath),
  },

  // Config snapshot + rollback (#270) — read-side IPC for the history
  // modal and the undo toast. Create is invoked main-side only.
  snapshot: {
    list:    (query)              => ipcRenderer.invoke('snapshot:list', query),
    restore: (feature, id, opts)  => ipcRenderer.invoke('snapshot:restore', feature, id, opts),
    pin:     (feature, id, pinned) => ipcRenderer.invoke('snapshot:pin', feature, id, pinned),
    delete:  (feature, id)        => ipcRenderer.invoke('snapshot:delete', feature, id),
  },

  // MCP management (#272/273/274).
  mcp: {
    list:           ()                     => ipcRenderer.invoke('mcp:list'),
    install:        (req)                  => ipcRenderer.invoke('mcp:install', req),
    remove:         (id, projectPath)      => ipcRenderer.invoke('mcp:remove', id, projectPath),
    sync:           (scope, projectPath)   => ipcRenderer.invoke('mcp:sync', scope, projectPath),
    probe:          (id)                   => ipcRenderer.invoke('mcp:probe', id),
    onListChanged:  (cb)                   => {
      const handler = (_e: unknown, d: { servers: Parameters<typeof cb>[0] }) =>
        cb(d.servers);
      ipcRenderer.on('mcp:list-changed', handler);
      return () => ipcRenderer.removeListener('mcp:list-changed', handler);
    },
  },

  // Sub-agent manager (#275).
  subAgents: {
    list:        (projectPath)             => ipcRenderer.invoke('subAgents:list', projectPath),
    install:     (projectPath, entry)      => ipcRenderer.invoke('subAgents:install', projectPath, entry),
    remove:      (projectPath, name)       => ipcRenderer.invoke('subAgents:remove', projectPath, name),
    autoImport:  (projectPath)             => ipcRenderer.invoke('subAgents:autoImport', projectPath),
    onChanged:   (cb)                      => {
      ipcRenderer.on('subAgents:changed', (_e, d) => cb(d));
    },
  },

  // Devia-native SDD (E-DSK-12) — bootstrap + kanban + notifications.
  sdd: {
    bootstrap:   (projectPath, force)      => ipcRenderer.invoke('sdd:bootstrap', projectPath, !!force),
    prepare:     (projectPath)             => ipcRenderer.invoke('sdd:prepare', projectPath),
    init:        (projectPath, intent, title) => ipcRenderer.invoke('sdd:create-spec', projectPath, intent, title ?? ''),
    markHandled: (projectPath, classification) => ipcRenderer.invoke('sdd:mark-handled', projectPath, classification),
    markEngaged: (projectPath)              => ipcRenderer.invoke('sdd:mark-engaged', projectPath),

    board:       (projectPath)             => ipcRenderer.invoke('kanban:board', projectPath),
    task:        (projectPath, taskId)     => ipcRenderer.invoke('kanban:task', projectPath, taskId),
    createTask:  (projectPath, specId, title, body, dependsOn) =>
      ipcRenderer.invoke('kanban:create-task', projectPath, specId, title, body ?? '', dependsOn ?? []),
    updateTask:  (projectPath, taskId, fields) => ipcRenderer.invoke('kanban:update-task', projectPath, taskId, fields),
    moveTask:    (projectPath, taskId, column) => ipcRenderer.invoke('kanban:move-task', projectPath, taskId, column),
    closeTask:   (projectPath, taskId, commit) => ipcRenderer.invoke('kanban:close-task', projectPath, taskId, commit),
    deleteTask:  (projectPath, taskId) => ipcRenderer.invoke('kanban:delete-task', projectPath, taskId),
    archiveSpec: (projectPath, specId, force) => ipcRenderer.invoke('kanban:archive-spec', projectPath, specId, force),
    blockTask:   (projectPath, taskId, reason, target) =>
      ipcRenderer.invoke('kanban:block-task', projectPath, taskId, reason, target),
    unblockTask: (projectPath, taskId, resolution) =>
      ipcRenderer.invoke('kanban:unblock-task', projectPath, taskId, resolution),
    comment:     (projectPath, taskId, body) => ipcRenderer.invoke('kanban:comment', projectPath, taskId, body),
    markTaskRead:(projectPath, taskId)     => ipcRenderer.invoke('kanban:mark-read', projectPath, taskId),
    onKanbanChanged: (cb)                  => { ipcRenderer.on('kanban:changed', (_e, d) => cb(d)); },
    onAgentWake: (cb)                      => { ipcRenderer.on('kanban:agent-wake', (_e, d) => cb(d)); },

    notifications:        (projectPath)    => ipcRenderer.invoke('sdd:notifications:get', projectPath),
    markNotificationsRead:(projectPath)    => ipcRenderer.invoke('sdd:notifications:mark-read', projectPath),
    clearNotifications:   (projectPath)    => ipcRenderer.invoke('sdd:notifications:clear', projectPath),
    onNotification:       (cb)             => { ipcRenderer.on('sdd:notification', (_e, d) => cb(d)); },
    notifyOs:             (title, body)    => ipcRenderer.invoke('sdd:notify-os', title, body),
  },

  // Devia internal memory + engram integration (S-1).
  memory: {
    detectEngram: ()        => ipcRenderer.invoke('memory:detect-engram'),
    importEngram: ()        => ipcRenderer.invoke('memory:import-engram'),
    search:       (query)   => ipcRenderer.invoke('memory:search', query),
    list:         (opts)    => ipcRenderer.invoke('memory:list', opts),
    listSessions: (opts)    => ipcRenderer.invoke('memory:list-sessions', opts),
    setPinned:    (args)    => ipcRenderer.invoke('memory:set-pinned', args),
    forget:       (args)    => ipcRenderer.invoke('memory:forget', args),
    clear:        (args)    => ipcRenderer.invoke('memory:clear', args),
  },

  // Remote control (E-DSK-14) — Telegram controller.
  remoteControl: {
    getStatus: ()           => ipcRenderer.invoke('remoteControl:get-status'),
    test:      (botToken)   => ipcRenderer.invoke('remoteControl:test', botToken),
    restart:   ()           => ipcRenderer.invoke('remoteControl:restart'),
    onStatus:  (cb)         => { ipcRenderer.on('remoteControl:status', (_e, d) => cb(d)); },
    onSelectProject: (cb)   => { ipcRenderer.on('remoteControl:select-project', (_e, d) => cb(d)); },
  },

  // Run mode per session — main is the source of truth.
  runMode: {
    set:       (project, mode) => ipcRenderer.invoke('runMode:set', project, mode),
    getAll:    ()              => ipcRenderer.invoke('runMode:get'),
    onChanged: (cb)            => { ipcRenderer.on('runMode:changed', (_e, d) => cb(d)); },
  },

  update: {
    check:    ()   => ipcRenderer.invoke('update:check'),
    install:  ()   => ipcRenderer.invoke('update:install'),
    onStatus: (cb) => { ipcRenderer.on('update:status', (_e, d) => cb(d)); },
  },
};

contextBridge.exposeInMainWorld('devia', bridge);
