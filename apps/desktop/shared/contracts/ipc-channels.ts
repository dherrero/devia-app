/**
 * Source of truth for every IPC channel name. Keeping these as a const object
 * lets every feature's IPC adapter import a typed handle instead of stringly
 * referencing a channel — channel drift between main and renderer becomes a
 * compile-time error.
 */
export const IPC = {
  // Workspace + config
  projectsList:    'projects:list',
  projectsSearch:  'projects:search',
  projectNew:      'project:new',
  folderNew:       'folder:new',
  folderRename:    'folder:rename',
  basesList:       'bases:list',
  basesReadJson:   'bases:read-json',
  basesWriteJson:  'bases:write-json',
  projectNewBase:  'project:new-base',
  projectTrash:    'project:trash',
  projectMove:     'project:move',
  configGet:       'config:get',
  configSet:       'config:set',
  configChanged:   'config:changed',
  dialogPickFolder:'dialog:pickFolder',
  dialogPickFile:  'dialog:pickFile',

  // Claude runner
  instructionSend: 'instruction:send',
  processStart:    'process:start',
  processEnd:      'process:end',
  processStop:     'process:stop',
  processStopAll:  'process:stop-all',
  /** REV-AGENT-CORE-001: targeted cancellation of a specific run by runId. */
  runCancel:       'run:cancel',
  sessionReset:    'session:reset',
  /** Cancel the pending automatic resume of a session (usage limit hit). */
  autoResumeCancel: 'autoresume:cancel',
  claudeOutput:    'claude:output',

  // Sessions
  chatsLoadAll:    'chats:loadAll',
  chatsSave:       'chats:save',
  chatsSaveAs:     'chats:save-as',
  sessionsList:    'sessions:list',
  sessionSwitch:   'session:switch',
  sessionDelete:   'session:delete',
  /** S-2 F3.1: main → renderer notification of a cross-agent session handoff. */
  sessionHandoff:  'session:handoff',
  /** S-2 F5.1: load an existing session under an additional pane's identity. */
  sessionAdopt:    'session:adopt',
  sessionsActiveStats: 'sessions:active-stats',
  statsAggregate:      'stats:aggregate',
  /** S-20 (generalises S-18): discover/import pre-existing CLI-agent sessions. */
  sessionImportScan:   'session-import:scan',
  sessionImportRun:    'session-import:run',

  // Status
  statusGet:       'status:get',

  // Pinned
  pinnedGet:       'pinned:get',
  pinnedSet:       'pinned:set',

  // Git
  gitInfo:            'git:info',
  gitWatch:           'git:watch',
  gitInfoChanged:     'git:info-changed',
  gitDiff:            'git:diff',
  gitSync:            'git:sync',
  gitPull:            'git:pull',
  gitListBranches:    'git:list-branches',
  gitCheckout:        'git:checkout',
  gitWorktreeAdd:     'git:worktree-add',
  gitWorktreeRemove:  'git:worktree-remove',
  gitWorktreeCleanup: 'git:worktree-cleanup',
  gitWorktreeList:    'git:worktree-list',

  // Compose
  composeRun:      'compose:run',
  composeStart:    'compose:start',
  composeOutput:   'compose:output',
  composeEnd:      'compose:end',
  dockerDetect:    'docker:detect',
  composeDetect:   'compose:detect',
  composeSearch:   'compose:search',

  // Clone
  cloneRun:        'clone:run',
  cloneStart:      'clone:start',
  cloneOutput:     'clone:output',
  cloneEnd:        'clone:end',

  // Outbox
  outboxFile:      'outbox:file',

  // Voice
  voiceTranscribe: 'voice:transcribe',

  // Shell
  shellOpenPath:   'shell:openPath',
  shellReveal:     'shell:reveal',
  shellOpenInIde:  'shell:openInIde',
  shellListIdes:   'shell:listIdes',
  /** Opens the saas upgrade page in the system default browser. The main
   *  process resolves the URL by reading `process.env.DEVIA_SAAS_URL` at
   *  boot (E-DSK-08 #258). */
  shellOpenUpgrade:'shell:open-upgrade',

  // Titlebar / custom window controls
  windowMinimize:     'window:minimize',
  windowToggleMaximize: 'window:toggle-maximize',
  windowClose:        'window:close',
  windowIsMaximized:  'window:is-maximized',

  // CLI adapters (multi-CLI selection in Settings)
  agentsList:      'agents:list',
  agentSelect:     'agent:select',
  agentSetModel:   'agent:setModel',
  agentSetEnv:     'agent:setEnv',
  agentTest:       'agent:test',
  agentChanged:    'agent:changed',

  // Integrated terminal (one PTY per project)
  terminalStart:   'terminal:start',
  terminalWrite:   'terminal:write',
  terminalResize:  'terminal:resize',
  terminalStop:    'terminal:stop',
  terminalData:    'terminal:data',
  terminalExit:    'terminal:exit',

  // Skills manager (per-project + global skill directories driven by `npx skills`)
  skillsList:      'skills:list',
  skillsInstall:   'skills:install',
  skillsRemove:    'skills:remove',
  skillsDiscover:        'skills:discover',
  skillsCancelDiscovery: 'skills:cancel-discovery',

  // Project tree (file explorer with git status overlay)
  projectTreeList: 'projectTree:list',

  // Instruction queue (AionUi-style per-project parking lot)
  queueList:       'queue:list',
  queueAdd:        'queue:add',
  queueRemove:     'queue:remove',
  queueEdit:       'queue:edit',
  queueMove:       'queue:move',
  queueClear:      'queue:clear',
  queuePause:      'queue:pause',
  queueResume:     'queue:resume',
  queueChanged:    'queue:changed',
  queueDispatched: 'queue:dispatched',

  // AskUserQuestion — multi-turn stdin protocol (TS-CLI-05)
  questionAsk:     'question:ask',
  questionAnswer:  'question:answer',

  // devia-ui interface tools (S-25). One generic pair for every tool; the
  // question card keeps its own channels above for back-compat.
  uiToolRequest:   'ui:tool-request',
  uiToolResult:    'ui:tool-result',
  uiToolsCatalog:  'uiTools:catalog',
  uiToolsGrants:   'uiTools:grants',
  uiToolsRevoke:   'uiTools:revoke',

  // Security audit log (TS-CLI-12 Phase 4)
  auditRead:       'audit:read',

  // Inline diff snapshots for file-editing tool results (TS-CLI-10)
  gitDiffSnapshot: 'git:diff-snapshot',

  // Prompt packs (REV-AGENT-CORE-003)
  promptPacksList:   'promptPacks:list',
  promptPacksRescan: 'promptPacks:rescan',

  // Devia SaaS — baked-at-boot baseUrl exposed to the renderer (E-DSK-08 #251).
  saasBaseUrl:     'saas:baseUrl',

  // Running app version (= release tag at build time) for the footer.
  appVersion:      'app:version',

  // Skill registry (#269) — per-project .devia/skill-registry.md index so
  // the active agent can lazy-load skills it would otherwise never know
  // about (project + global roots across all 8 supported agents).
  skillRegistryStatus:   'skillRegistry:status',
  skillRegistryRefresh:  'skillRegistry:refresh',
  skillRegistryWatch:    'skillRegistry:watch',
  skillRegistryChanged:  'skillRegistry:changed',
  skillRegistryRead:     'skillRegistry:read',

  // Config snapshot + rollback (#270) — every destructive op (skill
  // install/remove, MCP register, prompt-pack inject, spec-kit init)
  // captures the target files BEFORE writing so the user can undo a
  // bad change in one click.
  snapshotList:          'snapshot:list',
  snapshotRestore:       'snapshot:restore',
  snapshotPin:           'snapshot:pin',
  snapshotDelete:        'snapshot:delete',

  // MCP management (#272/273/274) — install/remove/sync per-agent
  // catalog plus a health probe for the modal "Probar" buttons.
  mcpInstall:            'mcp:install',
  mcpRemove:             'mcp:remove',
  mcpSync:               'mcp:sync',
  mcpProbe:              'mcp:probe',
  mcpListChanged:        'mcp:list-changed',

  // Sub-agent manager (#275) — per-project catalog + cross-CLI sync
  // for specialised agent prompts. Source of truth at
  // `<project>/.devia/sub-agents/<name>.md`.
  subAgentsList:         'subAgents:list',
  subAgentsInstall:      'subAgents:install',
  subAgentsRemove:       'subAgents:remove',
  subAgentsAutoImport:   'subAgents:autoImport',
  subAgentsChanged:      'subAgents:changed',

  // Devia-native SDD (E-DSK-12) — first-contact bootstrap + kanban.
  sddBootstrap:          'sdd:bootstrap',
  sddPrepare:            'sdd:prepare',
  sddCreateSpec:         'sdd:create-spec',
  sddMarkHandled:        'sdd:mark-handled',
  sddMarkEngaged:        'sdd:mark-engaged',
  // Kanban board (read + UI mutations).
  kanbanBoard:           'kanban:board',
  kanbanTask:            'kanban:task',
  kanbanCreateTask:      'kanban:create-task',
  kanbanUpdateTask:      'kanban:update-task',
  kanbanMoveTask:        'kanban:move-task',
  kanbanCloseTask:       'kanban:close-task',
  kanbanDeleteTask:      'kanban:delete-task',
  kanbanArchiveSpec:     'kanban:archive-spec',
  kanbanBlockTask:       'kanban:block-task',
  kanbanUnblockTask:     'kanban:unblock-task',
  kanbanComment:         'kanban:comment',
  kanbanMarkRead:        'kanban:mark-read',
  kanbanChanged:         'kanban:changed',
  kanbanAgentWake:       'kanban:agent-wake',
  // Notification center (T7).
  sddNotificationsGet:   'sdd:notifications:get',
  sddNotificationsClear: 'sdd:notifications:clear',
  sddNotificationsMarkRead: 'sdd:notifications:mark-read',
  sddNotification:       'sdd:notification',
  sddNotifyOs:           'sdd:notify-os',

  // Devia internal memory + engram integration (S-1). Detect/import the
  // external engram store; search/list Devia's own memory.
  memoryDetectEngram:    'memory:detect-engram',
  memoryImportEngram:    'memory:import-engram',
  memorySearch:          'memory:search',
  memoryList:            'memory:list',
  memoryListSessions:    'memory:list-sessions',
  // Memory management panel (E-DSK-13 #320): pin/unpin and soft-delete.
  memorySetPinned:       'memory:set-pinned',
  memoryForget:          'memory:forget',
  memoryClear:           'memory:clear',

  // Remote control (E-DSK-14) — Telegram controller embedded in the main
  // process. `status` is the event main→renderer; the rest are renderer→main.
  remoteControlGetStatus: 'remoteControl:get-status',
  remoteControlTest:      'remoteControl:test',
  remoteControlRestart:   'remoteControl:restart',
  remoteControlStatus:    'remoteControl:status',

  // Auto-update — electron-updater reading releases from the public
  // GitHub repo `dherrero/devia`. `updateStatus` is the push event
  // main→renderer; `updateCheck` and `updateInstall` are renderer→main.
  updateCheck:   'update:check',
  updateInstall: 'update:install',
  updateStatus:  'update:status',
} as const;

export type IpcChannel = (typeof IPC)[keyof typeof IPC];
