/**
 * Per-agent CLI preferences (model + reasoning effort). Keyed by the
 * agent id from the cli-adapters registry. Persisted in
 * devia-app.config.json so the user's selection survives restarts.
 */
export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

/**
 * Per-agent env overrides. The cli-adapters launcher enforces a
 * per-agent allowlist on the keys, so storing extra keys is safe — they
 * are silently ignored at spawn time.
 */
export type AgentCliEnvPrefs = Record<string, Record<string, string>>;

/**
 * Per-agent tool policy override (REV-AGENT-CORE-007). Layered on top of the
 * adapter's `defaultDisallowedTools` / `defaultAllowedTools`:
 *   - `disallow` extends the static denylist.
 *   - `allow` narrows the allowlist (intersected with the static allowlist).
 * Denylist always wins on conflict.
 */
export interface AgentToolPolicy {
  disallow?: string[];
  allow?: string[];
}

/** Telegram integration settings for remote control (E-DSK-14). */
export interface TelegramIntegrationConfig {
  /** Master switch for the Telegram controller. */
  enabled: boolean;
  /**
   * Bot API token. Persisted opaquely. The security task (E-DSK-14 #334)
   * encrypts it at rest with Electron `safeStorage` and redacts it from the
   * config view delivered to the renderer.
   */
  botToken: string;
  /** Numeric Telegram chat id authorised to control the app (allowlist of one). */
  chatId: string;
}

/**
 * Remote-control settings (E-DSK-14): a namespace for messaging integrations
 * that can drive the app while it is open. Only Telegram exists today.
 */
export interface RemoteControlConfig {
  /**
   * Allow shell passthrough (`/exec`, `!`) from a remote platform. Off by
   * default because it grants arbitrary command execution to whoever controls
   * the chat.
   */
  allowShell: boolean;
  /**
   * Mirror desktop-initiated conversations to the remote chat: when on, every
   * run started from the app pushes the user prompt and the agent's reply to
   * the chat (labelled with the project). Off by default. The remote → desktop
   * direction is always mirrored in the app regardless of this flag.
   */
  mirrorDesktop: boolean;
  /**
   * S-32 T-370 — allow the agent to send files to the remote chat via the
   * `devia_send_file` UI tool. ON by default (user decision). Risk: it uploads
   * file contents from this machine to the messaging platform's servers
   * (Telegram). This flag only turns the whole feature off; the safety limits
   * are fixed and NOT configurable: never anything outside
   * `config.workspaceRoot`, and never `.env*`, `.ssh/` or secret files (see
   * `isSecretPath` in `outbound-file-policy.ts`). Read on every run, so no
   * bot restart is needed when it changes.
   */
  allowFileSend: boolean;
  telegram: TelegramIntegrationConfig;
}

/** Devia internal memory configuration block. */
/** S-25 F3.3 — per-tool user preference for the `devia-ui` server. */
export interface UiToolsConfig {
  enabled: Partial<Record<import('./ui-tools').UiToolName, boolean>>;
}

export interface MemoryConfig {
  /** Master switch for the devia-memory feature. */
  enabled: boolean;
  /**
   * Isolate Devia-spawned runs to Devia's own MCP servers. For Claude this is
   * `--strict-mcp-config`, which loads ONLY the servers Devia passes and ignores
   * ANY ambient external MCP — engram, mcp-memory-service, the official memory
   * server, hand-edited `.mcp.json`, etc. Provider-neutral (renamed from the
   * engram-specific `blockEngram`; migrated transparently on load).
   */
  blockExternalMemory: boolean;
  /** Set to true after the user completes the one-time engram import. */
  engramImported: boolean;
  /** Epoch ms of when the engram import was completed. */
  engramImportedAt?: number;
}

export interface DeviaConfig {
  workspaceRoot: string;
  ignoreFolders: string[];

  /**
   * Active CLI adapter id. The registry validates this against the known
   * provider set on startup (`onReady`) and on every `agent:select` call,
   * falling back to `'claude'` (the only always-available default) if the
   * persisted id has been removed or is non-selectable.
   */
  agentId: string;
  /** Per-agent model + reasoning preferences. */
  agentModels: Record<string, AgentModelPrefs>;
  /** Per-agent env overrides (allowlist enforced by the launcher). */
  agentCliEnv: AgentCliEnvPrefs;

  /** UI language preference (es, en, fr, de, zh, hi). When unset, the
   *  renderer falls back to OS detection via `navigator.language`. Once
   *  the user picks a language in Settings it is persisted here and the
   *  detection is bypassed — user intent always wins. */
  language?: string;
  /**
   * Per-agent tool restriction overrides (REV-AGENT-CORE-007). Keyed by
   * agent id. Empty / absent entries fall back to the adapter's defaults.
   */
  agentToolPolicy: Record<string, AgentToolPolicy>;

  /**
   * Agents whose sessions Devia resumes by itself after the account's usage
   * limit resets (Claude Code subscription windows). Absent / false = off.
   */
  autoContinueSessions?: Record<string, boolean>;

  /**
   * Workspace-relative path of the last project the user worked on.
   * Restored on launch so the app reopens where they left off (and its
   * per-project scan runs during the splash). Empty / absent → no
   * project is auto-selected.
   */
  lastProjectPath?: string;

  /** Devia internal memory feature settings. */
  memory: MemoryConfig;


  /** Remote-control settings (E-DSK-14). Telegram is the only integration today. */
  remoteControl: RemoteControlConfig;

  /**
   * `devia-ui` interface tools (S-25 F3.3). A tool absent from `enabled` uses
   * the run-mode default; an explicit `false` withholds it. A preference can
   * only NARROW the mode policy, never widen it.
   */
  uiTools?: UiToolsConfig;

  /**
   * @deprecated S-3 F1.1: worktree isolation is MANDATORY for additional split
   * panes — this flag no longer gates the renderer's eager worktree creation
   * nor the runner's cwd re-pointing. Kept only so old config files parse.
   */
  worktreePerSession: boolean;

  /**
   * S-3 F1.2: which ref a session worktree's branch is created FROM.
   * 'default-branch' (the default) starts every session clean off the repo's
   * main branch — work in pane Z never inherits the primary pane's in-flight
   * commits. 'current' preserves the pre-S-3 behaviour (branch off HEAD).
   * Changing it never affects already-created worktrees.
   */
  worktreeBaseRef?: 'default-branch' | 'current';
}

export interface DeviaConfigView extends DeviaConfig {
  configPath: string;
  hasWorkspace: boolean;
}

export const DEFAULT_MEMORY_CONFIG: Readonly<MemoryConfig> = Object.freeze({
  enabled: true,
  blockExternalMemory: true,
  engramImported: false,
});

export const DEFAULT_REMOTE_CONTROL_CONFIG: Readonly<RemoteControlConfig> = Object.freeze({
  allowShell: false,
  mirrorDesktop: false,
  allowFileSend: true,
  telegram: Object.freeze({ enabled: false, botToken: '', chatId: '' }),
});

export const DEFAULT_CONFIG: Readonly<DeviaConfig> = Object.freeze({
  workspaceRoot: '',
  ignoreFolders: [],
  agentId: 'claude',
  agentModels: {},
  agentCliEnv: {},
  agentToolPolicy: {},
  memory: DEFAULT_MEMORY_CONFIG,
  remoteControl: DEFAULT_REMOTE_CONTROL_CONFIG,
  uiTools: { enabled: {} },
  worktreePerSession: false,
  worktreeBaseRef: 'default-branch',
});
