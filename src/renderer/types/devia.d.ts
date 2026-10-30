// Bridge exposed by preload.ts (contextBridge.exposeInMainWorld('devia', ...)).
// This file is the renderer-side shim: it re-exports the cross-side contracts
// from `shared/contracts/` and augments `Window` with the typed bridge.

export type { DeviaBridge } from '../../shared/contracts/devia-bridge';
export type {
  DeviaConfig,
  DeviaConfigView,
  RemoteControlConfig,
  TelegramIntegrationConfig,
} from '../../shared/domain/config';
export type {
  RemoteControlState,
  RemoteControlStatus,
  TelegramTestResult,
} from '../../shared/domain/remote-control';
export type { UpdateState, UpdateStatus } from '../../shared/domain/update';
export type {
  ProjectEntry,
  ProjectTech,
  PinnedEntry,
} from '../../shared/domain/project';
export type { SessionMeta } from '../../shared/domain/session';
export type {
  ProjectBase,
  BaseCopyEntry,
  BasesMap,
  NewFromBaseResult,
} from '../../shared/domain/base';
export type {
  GitInfo,
  DiffLine,
  DiffLineType,
  DiffFile,
  DiffFileStatus,
  DiffResult,
} from '../../shared/domain/git';
export type { StatusInfo, StatusProjectEntry } from '../../shared/domain/status';
export type {
  AttachmentPayload,
  OutboxFile,
  OutboxFileKind,
} from '../../shared/domain/attachment';
export type { CloneRequest } from '../../shared/domain/clone';
export type { ComposeAction } from '../../shared/domain/compose';
export type {
  ProcessStartEvent,
  SessionHandoffEvent,
  SessionResetEvent,
  AutoResumeScheduledEvent,
  AutoResumeCancelledEvent,
  ProcessEndEvent,
  ClaudeOutputEvent,
  ComposeStartEvent,
  ComposeOutputEvent,
  ComposeEndEvent,
  CloneStartEvent,
  CloneOutputEvent,
  CloneEndEvent,
  GitInfoChangedEvent,
  NotificationClickEvent,
  TerminalDataEvent,
  TerminalExitEvent,
  QuestionAskEvent,
  QuestionPrompt,
  QuestionOption,
  DiffSnapshotEvent,
  AgentsDetectedEvent,
} from '../../shared/contracts/events';
export type {
  TerminalSize,
  TerminalStartResult,
} from '../../shared/contracts/devia-bridge';
export type {
  DetectedAgentView,
  AgentModelOption,
  AgentReasoningOption,
  AgentChangedEvent,
  SetAgentModelInput,
  SetAgentEnvInput,
  TestAgentResult,
} from '../../shared/domain/agent';
export type {
  QueueItem,
  ProjectQueueView,
  QueueChangedEvent,
  QueueDispatchedEvent,
  SendInstructionResult,
} from '../../shared/domain/queue';
export type {
  InstalledSkill,
  ListSkillsResult,
  InstallSkillsRequest,
  RemoveSkillRequest,
  SkillsRunResult,
  SkillScope,
  SkillAgent,
  DiscoveredSkill,
  DiscoverSkillsRequest,
  DiscoverSkillsResult,
} from '../../shared/domain/skill';
export type { AuditEntry } from '../../shared/contracts/devia-bridge';
export type {
  SkillRegistryEntry,
  SkillRegistrySnapshot,
  SkillRegistryRefreshResult,
  SkillRegistryChangedEvent,
  SkillRegistryRefreshReason,
} from '../../shared/domain/skill-registry';
export type {
  SnapshotFeature,
  SnapshotSummary,
  SnapshotRestoreResult,
  ListSnapshotsQuery,
} from '../../shared/domain/snapshot';
export type {
  McpAgentId,
  McpScope,
  McpSource,
  McpServerView,
  McpInstallResult,
  McpProbeResult,
  McpCatalogEntry,
  McpListChangedEvent,
} from '../../shared/domain/mcp';
export type {
  SubAgent,
  SubAgentCliId,
  SubAgentView,
  SubAgentInstallResult,
  SubAgentImportResult,
  SubAgentCatalogEntry,
  SubAgentListChangedEvent,
} from '../../shared/domain/sub-agents';
export type {
  KanbanColumn,
  BlockReason,
  ThreadAuthor,
  KanbanSpec,
  ThreadMessage,
  SubagentInvocation,
  KanbanCardView,
  KanbanBoardView,
  KanbanTaskView,
  KanbanChangedEvent,
  KanbanAgentWakeEvent,
  AgentWakeReason,
} from '../../shared/domain/kanban';
export type {
  ProjectClassification,
  BootstrapView,
  SddPromptResult,
  SddNotification,
  SddNotificationKind,
  SddNotificationEvent,
} from '../../shared/domain/sdd';

// NOTE: runtime values (functions / consts) MUST NOT be re-exported
// from a `.d.ts` file — the bundler emits no JS for declaration
// files, so the import resolves to a missing module at build time
// (esbuild "Could not resolve '../types/devia'"). Consumers import
// runtime helpers directly from `shared/domain/*` instead.

import type { DeviaBridge } from '../../shared/contracts/devia-bridge';

declare global {
  interface Window {
    devia: DeviaBridge;
  }
}
