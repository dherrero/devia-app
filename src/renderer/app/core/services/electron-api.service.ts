import { Injectable } from '@angular/core';
import type { DeviaBridge } from '../../../types/devia';
import type { SessionStats } from '../../../../shared/domain/session-stats';
import type { BranchCheckoutRef } from '../../../../shared/domain/git';

// Thin Angular wrapper around window.devia. Centralising it lets components
// inject this service instead of touching window directly, which keeps the
// preload contract surface in one place and makes mocking trivial in tests.

@Injectable({ providedIn: 'root' })
export class ElectronApiService {
  private readonly api: DeviaBridge = window.devia;

  get platform() { return this.api.platform; }
  get isWSL()    { return this.api.isWSL; }

  // Config
  getConfig()                       { return this.api.getConfig(); }
  setConfig(p: Parameters<DeviaBridge['setConfig']>[0]) { return this.api.setConfig(p); }
  pickFolder(opts?: Parameters<DeviaBridge['pickFolder']>[0]) { return this.api.pickFolder(opts); }
  pickFile(opts?:   Parameters<DeviaBridge['pickFile']>[0])   { return this.api.pickFile(opts); }

  // Projects
  listProjects(subpath = '') { return this.api.listProjects(subpath); }
  searchProjects(query: string) { return this.api.searchProjects(query); }
  newProject(name: string, parent = '') { return this.api.newProject(name, parent); }
  newFolder(name: string, parent = '')  { return this.api.newFolder(name, parent); }
  renameFolder(folderPath: string, newName: string) { return this.api.renameFolder(folderPath, newName); }
  moveProject(sourcePath: string, targetFolderPath: string) { return this.api.moveProject(sourcePath, targetFolderPath); }
  listBases() { return this.api.listBases(); }
  readBasesJson() { return this.api.readBasesJson(); }
  writeBasesJson(text: string) { return this.api.writeBasesJson(text); }
  newFromBase(base: string, name: string, parent = '') { return this.api.newFromBase(base, name, parent); }
  trashProject(projectPath: string) { return this.api.trashProject(projectPath); }
  loadChats() { return this.api.loadChats(); }
  loadActiveStats() { return this.api.loadActiveStats(); }
  aggregateStats() { return this.api.aggregateStats(); }
  saveChat(projectPath: string, messages: unknown[], stats?: SessionStats) { return this.api.saveChat(projectPath, messages, stats); }
  saveChatAs(baseProject: string, sessionId: string, messages: unknown[], stats?: SessionStats, workdir?: string, worktreeBranch?: string) { return this.api.saveChatAs(baseProject, sessionId, messages, stats, workdir, worktreeBranch); }
  listSessions(projectPath: string) { return this.api.listSessions(projectPath); }
  switchSession(projectPath: string, sessionId: string) { return this.api.switchSession(projectPath, sessionId); }
  adoptSession(baseProject: string, runKey: string, sessionId: string) { return this.api.adoptSession(baseProject, runKey, sessionId); }
  deleteSession(projectPath: string, sessionId: string) { return this.api.deleteSession(projectPath, sessionId); }
  scanSessionImport() { return this.api.scanSessionImport(); }
  runSessionImport(
    selections: Parameters<typeof this.api.runSessionImport>[0],
    opts?: Parameters<typeof this.api.runSessionImport>[1],
  ) { return this.api.runSessionImport(selections, opts); }

  // Claude / processes
  sendInstruction(
    project: string,
    text: string,
    attachments?: Parameters<DeviaBridge['sendInstruction']>[2],
    /** REV-AGENT-CORE-006: optional run mode. Defaults to 'apply' main-side. */
    mode?: 'plan' | 'apply' | 'apply-yolo',
    /** Bubble text replayed on queue:dispatched when `text` is an internal prompt. */
    displayText?: string,
    /** S-13 T-143: per-pane session identity (`runKey`) + worktree isolation. */
    runOpts?: Parameters<DeviaBridge['sendInstruction']>[5],
  ) {
    return this.api.sendInstruction(project, text, attachments, mode, displayText, runOpts);
  }
  stopProject(project: string)  { return this.api.stopProject(project); }
  resetSession(project: string) { return this.api.resetSession(project); }
  cancelAutoResume(project: string) { return this.api.cancelAutoResume(project); }
  stopAll()                     { return this.api.stopAll(); }
  /** REV-AGENT-CORE-001: cancel a specific run by id (no-op if already done). */
  cancelRun(runId: string)      { return this.api.cancelRun(runId); }

  // Per-project queue
  listQueue(project: string)                  { return this.api.listQueue(project); }
  addToQueue(project: string, text: string)   { return this.api.addToQueue(project, text); }
  removeFromQueue(project: string, id: string){ return this.api.removeFromQueue(project, id); }
  editInQueue(project: string, id: string, text: string) { return this.api.editInQueue(project, id, text); }
  moveInQueue(project: string, id: string, newIndex: number) { return this.api.moveInQueue(project, id, newIndex); }
  clearQueue(project: string)                 { return this.api.clearQueue(project); }
  pauseQueue(project: string)                 { return this.api.pauseQueue(project); }
  resumeQueue(project: string)                { return this.api.resumeQueue(project); }
  getStatus()                   { return this.api.getStatus(); }
  getAppVersion()               { return this.api.getAppVersion(); }
  getPinned()                   { return this.api.getPinned(); }
  setPinned(paths: string[])    { return this.api.setPinned(paths); }
  getGitInfo(projectPath: string) { return this.api.getGitInfo(projectPath); }
  watchGit(projectPath: string | null) { return this.api.watchGit(projectPath); }
  getGitDiff(projectPath: string) { return this.api.getGitDiff(projectPath); }
  syncGit(projectPath: string)    { return this.api.syncGit(projectPath); }
  pullGit(projectPath: string)    { return this.api.pullGit(projectPath); }
  listBranches(projectPath: string) { return this.api.listBranches(projectPath); }
  checkoutBranch(projectPath: string, ref: BranchCheckoutRef) { return this.api.checkoutBranch(projectPath, ref); }
  addWorktree(baseProject: string, sessionId: string) { return this.api.addWorktree(baseProject, sessionId); }
  removeWorktree(baseProject: string, sessionId: string) { return this.api.removeWorktree(baseProject, sessionId); }
  cleanupWorktree(baseProject: string, sessionId: string) { return this.api.cleanupWorktree(baseProject, sessionId); }
  listWorktrees(baseProject: string) { return this.api.listWorktrees(baseProject); }

  // Project tree (file explorer with git status overlay)
  listProjectTree(project: string, subPath = '', force = false) {
    return this.api.listProjectTree(project, subPath, force);
  }


  // Compose
  runCompose(project: string, action: 'deploy' | 'down' | 'logs', composeFile?: string) {
    this.api.runCompose(project, action, composeFile);
  }
  dockerDetect() {
    return this.api.dockerDetect();
  }
  composeDetect(project: string) {
    return this.api.composeDetect(project);
  }
  composeSearch(project: string) {
    return this.api.composeSearch(project);
  }

  // Clone an arbitrary git URL into the workspace.
  cloneRepo(payload: Parameters<DeviaBridge['cloneRepo']>[0]) {
    this.api.cloneRepo(payload);
  }

  // Shell
  openPath(p: string)       { return this.api.openPath(p); }
  revealInFolder(p: string) { return this.api.revealInFolder(p); }
  openInIde(p: string, ideId?: Parameters<DeviaBridge['openInIde']>[1]) { return this.api.openInIde(p, ideId); }
  listIdes()                { return this.api.listIdes(); }
  openUpgrade(feature: string) { return this.api.openUpgrade(feature); }
  minimizeWindow()          { return this.api.minimizeWindow(); }
  toggleMaximizeWindow()    { return this.api.toggleMaximizeWindow(); }
  closeWindow()             { return this.api.closeWindow(); }
  isWindowMaximized()       { return this.api.isWindowMaximized(); }

  // Voice
  transcribe(buffer: ArrayBuffer) { return this.api.transcribe(buffer); }

  // Integrated terminal — one PTY per project, survives panel hide/show.
  terminalStart(project: string, size: Parameters<DeviaBridge['terminalStart']>[1]) {
    return this.api.terminalStart(project, size);
  }
  terminalWrite(project: string, data: string)  { this.api.terminalWrite(project, data); }
  terminalResize(project: string, size: Parameters<DeviaBridge['terminalResize']>[1]) {
    this.api.terminalResize(project, size);
  }
  terminalStop(project: string)                 { return this.api.terminalStop(project); }

  // Skills manager
  listSkills(project: string) { return this.api.listSkills(project); }
  installSkills(req: Parameters<DeviaBridge['installSkills']>[0]) { return this.api.installSkills(req); }
  removeSkill(req: Parameters<DeviaBridge['removeSkill']>[0]) { return this.api.removeSkill(req); }
  discoverSkills(req: Parameters<DeviaBridge['discoverSkills']>[0]) { return this.api.discoverSkills(req); }
  cancelSkillDiscovery(id: string) { return this.api.cancelSkillDiscovery(id); }

  // CLI adapters (multi-CLI picker in Settings)
  listAgents() { return this.api.listAgents(); }
  selectAgent(agentId: string) { return this.api.selectAgent(agentId); }
  setAgentModel(input: Parameters<DeviaBridge['setAgentModel']>[0]) { return this.api.setAgentModel(input); }
  setAgentEnv(input: Parameters<DeviaBridge['setAgentEnv']>[0]) { return this.api.setAgentEnv(input); }
  testAgent(agentId: string) { return this.api.testAgent(agentId); }

  // Event subscriptions — these all return void; cleanup happens via
  // ipcRenderer.removeListener in main.process if ever needed. For our
  // singleton-service pattern, listeners live for the lifetime of the app.
  onClaudeOutput   = this.api.onClaudeOutput.bind(this.api);
  onProcessStart   = this.api.onProcessStart.bind(this.api);
  onSessionHandoff = this.api.onSessionHandoff.bind(this.api);
  onSessionReset   = this.api.onSessionReset.bind(this.api);
  onAutoResumeScheduled = this.api.onAutoResumeScheduled.bind(this.api);
  onAutoResumeCancelled = this.api.onAutoResumeCancelled.bind(this.api);
  onProcessEnd     = this.api.onProcessEnd.bind(this.api);
  onComposeStart   = this.api.onComposeStart.bind(this.api);
  onComposeOutput  = this.api.onComposeOutput.bind(this.api);
  onComposeEnd     = this.api.onComposeEnd.bind(this.api);
  onOutboxFile     = this.api.onOutboxFile.bind(this.api);
  onCloneStart     = this.api.onCloneStart.bind(this.api);
  onCloneOutput    = this.api.onCloneOutput.bind(this.api);
  onCloneEnd       = this.api.onCloneEnd.bind(this.api);
  onGitInfoChanged = this.api.onGitInfoChanged.bind(this.api);
  onConfigChanged  = this.api.onConfigChanged.bind(this.api);
  onNotificationClick = this.api.onNotificationClick.bind(this.api);
  onAgentChanged   = this.api.onAgentChanged.bind(this.api);
  onQueueChanged   = this.api.onQueueChanged.bind(this.api);
  onQueueDispatched = this.api.onQueueDispatched.bind(this.api);
  onTerminalData   = this.api.onTerminalData.bind(this.api);
  onTerminalExit   = this.api.onTerminalExit.bind(this.api);

  // AskUserQuestion multi-turn protocol (TS-CLI-05)
  onQuestionAsk    = this.api.onQuestionAsk.bind(this.api);
  questionAnswer(project: string, toolUseId: string, answer: string) {
    return this.api.questionAnswer(project, toolUseId, answer);
  }

  // devia-ui interface tools (S-25)
  onUiToolRequest  = this.api.onUiToolRequest.bind(this.api);
  sendUiToolResult(project: string, callId: string, answer: string) {
    return this.api.sendUiToolResult(project, callId, answer);
  }
  listUiToolCatalog() {
    return this.api.listUiToolCatalog();
  }
  listUiToolGrants(project: string) {
    return this.api.listUiToolGrants(project);
  }
  revokeUiToolGrant(project: string, action?: string) {
    return this.api.revokeUiToolGrant(project, action);
  }

  // Inline diff snapshots for file-editing tool results (TS-CLI-10)
  onDiffSnapshot   = this.api.onDiffSnapshot.bind(this.api);

  // Agent detection push — fired once at startup when probing completes.
  onAgentsDetected(cb: Parameters<DeviaBridge['onAgentsDetected']>[0]) {
    return this.api.onAgentsDetected(cb);
  }

  // Security audit log (TS-CLI-12 Phase 4)
  readAuditLog(n: number) { return this.api.readAuditLog(n); }

  // Skill registry (#269). Thin pass-through to bridge.skillRegistry.*.
  skillRegistryStatus(projectPath: string) {
    return this.api.skillRegistry.status(projectPath);
  }
  skillRegistryRefresh(projectPath: string) {
    return this.api.skillRegistry.refresh(projectPath);
  }
  skillRegistryWatch(projectPath: string | null) {
    return this.api.skillRegistry.watch(projectPath);
  }
  onSkillRegistryChanged(cb: Parameters<typeof this.api.skillRegistry.onChanged>[0]) {
    this.api.skillRegistry.onChanged(cb);
  }
  skillRegistryRead(projectPath: string) {
    return this.api.skillRegistry.read(projectPath);
  }

  // Snapshot / rollback (#270). Read-side only — creation is main-side.
  snapshotList(query: Parameters<typeof this.api.snapshot.list>[0] = {}) {
    return this.api.snapshot.list(query);
  }
  snapshotRestore(
    feature: Parameters<typeof this.api.snapshot.restore>[0],
    id: string,
    options?: { safe?: boolean },
  ) {
    return this.api.snapshot.restore(feature, id, options);
  }
  snapshotPin(
    feature: Parameters<typeof this.api.snapshot.pin>[0],
    id: string,
    pinned: boolean,
  ) {
    return this.api.snapshot.pin(feature, id, pinned);
  }
  snapshotDelete(
    feature: Parameters<typeof this.api.snapshot.delete>[0],
    id: string,
  ) {
    return this.api.snapshot.delete(feature, id);
  }

  // MCP management (#272/273/274). Read side + install / remove / probe.
  mcpList() { return this.api.mcp.list(); }
  mcpInstall(req: Parameters<typeof this.api.mcp.install>[0]) {
    return this.api.mcp.install(req);
  }
  mcpRemove(id: string, projectPath?: string) {
    return this.api.mcp.remove(id, projectPath);
  }
  mcpSync(scope?: Parameters<typeof this.api.mcp.sync>[0], projectPath?: string) {
    return this.api.mcp.sync(scope, projectPath);
  }
  mcpProbe(id: string) { return this.api.mcp.probe(id); }
  onMcpListChanged(cb: Parameters<typeof this.api.mcp.onListChanged>[0]): () => void {
    return this.api.mcp.onListChanged(cb);
  }

  // Sub-agent manager (#275).
  subAgentsList(projectPath: string) {
    return this.api.subAgents.list(projectPath);
  }
  subAgentsInstall(
    projectPath: string,
    entry: Parameters<typeof this.api.subAgents.install>[1],
  ) {
    return this.api.subAgents.install(projectPath, entry);
  }
  subAgentsRemove(projectPath: string, name: string) {
    return this.api.subAgents.remove(projectPath, name);
  }
  subAgentsAutoImport(projectPath: string) {
    return this.api.subAgents.autoImport(projectPath);
  }
  onSubAgentsChanged(cb: Parameters<typeof this.api.subAgents.onChanged>[0]) {
    this.api.subAgents.onChanged(cb);
  }

  // Devia internal memory + engram integration (S-1).
  detectEngram() { return this.api.memory.detectEngram(); }
  importEngram() { return this.api.memory.importEngram(); }
  searchMemory(query: Parameters<typeof this.api.memory.search>[0]) {
    return this.api.memory.search(query);
  }
  listMemory(opts?: Parameters<typeof this.api.memory.list>[0]) {
    return this.api.memory.list(opts);
  }
  listMemorySessions(opts?: Parameters<typeof this.api.memory.listSessions>[0]) {
    return this.api.memory.listSessions(opts);
  }
  setMemoryPinned(args: Parameters<typeof this.api.memory.setPinned>[0]) {
    return this.api.memory.setPinned(args);
  }
  forgetMemory(args: Parameters<typeof this.api.memory.forget>[0]) {
    return this.api.memory.forget(args);
  }
  clearMemory(args?: Parameters<typeof this.api.memory.clear>[0]) {
    return this.api.memory.clear(args);
  }

  // Devia-native SDD (E-DSK-12). Thin pass-through to bridge.sdd.*.
  sddBootstrap(projectPath: string, force?: boolean) {
    return this.api.sdd.bootstrap(projectPath, force);
  }
  sddPrepare(projectPath: string) {
    return this.api.sdd.prepare(projectPath);
  }
  sddInit(projectPath: string, intent: string, title?: string) {
    return this.api.sdd.init(projectPath, intent, title);
  }
  sddMarkHandled(projectPath: string, classification: Parameters<typeof this.api.sdd.markHandled>[1]) {
    return this.api.sdd.markHandled(projectPath, classification);
  }
  sddMarkEngaged(projectPath: string) {
    return this.api.sdd.markEngaged(projectPath);
  }
  kanbanBoard(projectPath: string) {
    return this.api.sdd.board(projectPath);
  }
  kanbanTask(projectPath: string, taskId: string) {
    return this.api.sdd.task(projectPath, taskId);
  }
  kanbanCreateTask(
    projectPath: string,
    specId: string,
    title: string,
    body?: string,
    dependsOn?: string[],
  ) {
    return this.api.sdd.createTask(projectPath, specId, title, body, dependsOn);
  }
  kanbanUpdateTask(
    projectPath: string,
    taskId: string,
    fields: Parameters<typeof this.api.sdd.updateTask>[2],
  ) {
    return this.api.sdd.updateTask(projectPath, taskId, fields);
  }
  kanbanMoveTask(
    projectPath: string,
    taskId: string,
    column: Parameters<typeof this.api.sdd.moveTask>[2],
  ) {
    return this.api.sdd.moveTask(projectPath, taskId, column);
  }
  kanbanCloseTask(projectPath: string, taskId: string, commit?: string) {
    return this.api.sdd.closeTask(projectPath, taskId, commit);
  }
  kanbanDeleteTask(projectPath: string, taskId: string) {
    return this.api.sdd.deleteTask(projectPath, taskId);
  }
  kanbanArchiveSpec(projectPath: string, specId: string, force?: boolean) {
    return this.api.sdd.archiveSpec(projectPath, specId, force);
  }
  kanbanBlockTask(
    projectPath: string,
    taskId: string,
    reason: Parameters<typeof this.api.sdd.blockTask>[2],
    target?: string,
  ) {
    return this.api.sdd.blockTask(projectPath, taskId, reason, target);
  }
  kanbanUnblockTask(projectPath: string, taskId: string, resolution?: string) {
    return this.api.sdd.unblockTask(projectPath, taskId, resolution);
  }
  kanbanComment(projectPath: string, taskId: string, body: string) {
    return this.api.sdd.comment(projectPath, taskId, body);
  }
  kanbanMarkTaskRead(projectPath: string, taskId: string) {
    return this.api.sdd.markTaskRead(projectPath, taskId);
  }
  onKanbanChanged(cb: Parameters<typeof this.api.sdd.onKanbanChanged>[0]) {
    this.api.sdd.onKanbanChanged(cb);
  }
  onAgentWake(cb: Parameters<typeof this.api.sdd.onAgentWake>[0]) {
    this.api.sdd.onAgentWake(cb);
  }
  sddNotifications(projectPath?: string) {
    return this.api.sdd.notifications(projectPath);
  }
  sddMarkNotificationsRead(projectPath?: string) {
    return this.api.sdd.markNotificationsRead(projectPath);
  }
  sddClearNotifications(projectPath?: string) {
    return this.api.sdd.clearNotifications(projectPath);
  }
  onSddNotification(cb: Parameters<typeof this.api.sdd.onNotification>[0]) {
    this.api.sdd.onNotification(cb);
  }
  sddNotifyOs(title: string, body: string) {
    return this.api.sdd.notifyOs(title, body);
  }

  // Remote control (E-DSK-14) — Telegram controller. Thin pass-through to
  // bridge.remoteControl.*.
  remoteControlGetStatus() { return this.api.remoteControl.getStatus(); }
  remoteControlTest(botToken: string) { return this.api.remoteControl.test(botToken); }
  remoteControlRestart() { return this.api.remoteControl.restart(); }
  onRemoteControlStatus(cb: Parameters<typeof this.api.remoteControl.onStatus>[0]) {
    this.api.remoteControl.onStatus(cb);
  }
  onRemoteSelectProject(cb: Parameters<typeof this.api.remoteControl.onSelectProject>[0]) {
    this.api.remoteControl.onSelectProject(cb);
  }

  // Run mode per session — thin pass-through to bridge.runMode.*.
  setRunModeRemote(project: string, mode: Parameters<typeof this.api.runMode.set>[1]) {
    return this.api.runMode.set(project, mode);
  }
  getRunModes() { return this.api.runMode.getAll(); }
  onRunModeChanged(cb: Parameters<typeof this.api.runMode.onChanged>[0]) {
    this.api.runMode.onChanged(cb);
  }

  // Auto-update (electron-updater). Thin pass-through to bridge.update.*.
  checkUpdate() { return this.api.update.check(); }
  installUpdate() { return this.api.update.install(); }
  onUpdateStatus(cb: Parameters<typeof this.api.update.onStatus>[0]) {
    this.api.update.onStatus(cb);
  }
}
