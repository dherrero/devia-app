/**
 * Declarative runtime catalog for every CLI the app can drive (claude,
 * codex, gemini, opencode, …). Each entry is a value the cli-adapters
 * feature uses to detect, spawn, and parse the CLI's output stream.
 *
 * Inspired by open-design's `RuntimeAgentDef`; trimmed for Devia's
 * smaller surface. Extended with image-path support, prompt argv-budget
 * guard, async model fetch, and MCP discovery tag.
 */

export type RuntimeEnv = NodeJS.ProcessEnv | Record<string, string>;

export interface RuntimeModelOption {
  id: string;
  label: string;
}

export type RuntimeReasoningOption = RuntimeModelOption;

export interface RuntimeBuildOptions {
  model?: string | null;
  reasoning?: string | null;
}

export interface RuntimeContext {
  cwd?: string;
  /**
   * Agent session to resume, for adapters whose resume form is a SUBCOMMAND
   * rather than an appendable flag (e.g. Codex `exec resume <id>` — the id
   * must sit right after `exec`, so `buildResumeArgs` can't express it).
   * Adapters that don't support context-based resume simply ignore it.
   */
  resumeSessionId?: string;
}

export interface RuntimeListModels {
  args: string[];
  timeoutMs?: number;
  parse: (stdout: string) => RuntimeModelOption[] | null;
}

/** Canonical stream formats emitted by the catalog's parsers. */
export type RuntimeStreamFormat =
  | 'plain'
  | 'claude-stream-json'
  | 'json-event-stream'
  | 'acp-json-rpc'
  | 'pi-rpc';

/**
 * Provider integration type — distinguishes how Devia talks to the agent.
 *
 *   - `'cli'`         — local CLI binary discovered on PATH (default; the
 *                       only kind Devia can spawn today).
 *   - `'api'`         — direct HTTP API (requires env keys, no local binary).
 *                       Detection reports `configured: true` when env keys
 *                       are present; execution is not yet implemented.
 *   - `'mcp'`         — agent fronted by a Model Context Protocol server.
 *                       Detection only checks config presence.
 *   - `'local-model'` — local model runtime (e.g. ollama) accessed via HTTP.
 *   - `'planned'`     — known agent not yet executable in Devia. Shown in
 *                       the registry/UI so users see the roadmap; the
 *                       SelectAgentUseCase rejects activation.
 *
 * `undefined` is treated as `'cli'` for backward compatibility with the
 * six built-in adapters (claude, codex, gemini, opencode, cursor-agent,
 * copilot) and with any user-supplied `agent-defs.json` entries that
 * predate this field.
 */
export type RuntimeProviderType =
  | 'cli'
  | 'api'
  | 'mcp'
  | 'local-model'
  | 'planned';

/**
 * How well the provider concept maps onto Devia today.
 *   - `'direct'`         — fully integrated, indistinguishable from a built-in.
 *   - `'adapted'`        — present but with reduced features (e.g. plain-text
 *                          stream only).
 *   - `'planned'`        — registered for visibility, not yet usable.
 *   - `'not-applicable'` — referenced for completeness but should not be
 *                          surfaced to end users.
 */
export type RuntimeApplicability =
  | 'direct'
  | 'adapted'
  | 'planned'
  | 'not-applicable';

/** Identifier passed to the parser factory for `json-event-stream` agents. */
export type RuntimeEventParser = 'codex' | 'gemini' | 'opencode' | 'cursor-agent' | 'copilot' | 'qoder' | 'grok';

/**
 * Conversation continuity model (S-19 F0).
 *   - `'native'` — continuity relies on the CLI's own session: the parser
 *     emits `session_started`, the use case stores `agentSessionId` and
 *     resumes via `buildResumeArgs` / `RuntimeContext.resumeSessionId`.
 *   - `'replay'` — the CLI exposes no clean resume handle, so Devia re-seeds
 *     the prior conversation transcript into the prompt each turn
 *     (`buildConversationReplay`).
 */
export type RuntimeContinuity = 'native' | 'replay';

export interface RuntimeAgentDef {
  id: string;
  name: string;
  /** Primary executable name resolved on PATH. */
  bin: string;
  /** Drop-in forks tried in order when `bin` isn't on PATH. */
  fallbackBins?: string[];
  /**
   * Integration type. `undefined` is treated as `'cli'` so existing
   * adapters and user-supplied defs keep working without migration.
   */
  providerType?: RuntimeProviderType;
  /**
   * Applicability tag — describes how well this provider is supported in
   * Devia today. Surfaced in the UI so users understand whether selecting
   * an entry will work end-to-end. Defaults to `'direct'` for built-in
   * CLI adapters when omitted.
   */
  applicability?: RuntimeApplicability;
  /**
   * For `providerType === 'api' | 'local-model'`: env keys the user must
   * set for the provider to be considered configured. Detection reports
   * `configured: true` only when every listed key is present in the
   * effective environment (after env overrides). Never read or returned
   * by value — only existence is checked, so secrets do not leak to the
   * renderer.
   */
  requiredEnvKeys?: readonly string[];
  /**
   * For `providerType === 'mcp'`: config keys whose presence indicates the
   * MCP server is configured. Devia inspects its own config, never
   * launches third-party MCP servers during detection.
   */
  requiredConfigKeys?: readonly string[];
  /**
   * Static fallback reason shown when this provider is not yet usable
   * (typically `providerType !== 'cli'`). The detection layer overrides
   * this with a more specific message when it can determine one.
   */
  unavailableReason?: string;
  versionArgs: string[];
  /** Args used to probe `--help` for capability flags. */
  helpArgs?: string[];
  capabilityFlags?: Record<string, string>;
  fallbackModels: RuntimeModelOption[];
  reasoningOptions?: RuntimeReasoningOption[];
  listModels?: RuntimeListModels;
  /**
   * Build the argv the launcher will hand to `spawn(bin, args)`. The
   * composed user prompt is delivered via stdin (gated by
   * `promptViaStdin`), not appended here; the param exists for symmetry
   * with future agents that need it.
   *
   * `imagePaths` (position two) carries validated workspace-relative image
   * file paths for multimodal agents. Adapters that do not support images
   * should name this param `_imagePaths` and ignore it.
   */
  buildArgs: (
    prompt: string,
    imagePaths: string[],
    extraAllowedDirs?: string[],
    options?: RuntimeBuildOptions,
    runtimeContext?: RuntimeContext,
  ) => string[];
  /**
   * True when the agent CLI accepts image file paths as attachments.
   * Drives the UI file-picker and pre-flight validation in the use case.
   */
  supportsImagePaths?: boolean;
  /**
   * Maximum byte length of the composed prompt when the adapter passes the
   * prompt via argv (not stdin). Pre-flight guard before spawn to avoid
   * OS-level ENAMETOOLONG / CreateProcess failures on Windows. Adapters
   * that use `promptViaStdin: true` leave this unset.
   */
  maxPromptArgBytes?: number;
  /**
   * Async model list for agents with a JSON model API. Called by the
   * detection layer; errors must be caught there and fall back to
   * `fallbackModels`. Returns null when the agent does not support dynamic
   * model enumeration.
   */
  fetchModels?: (
    resolvedBin: string,
    env: RuntimeEnv,
  ) => Promise<RuntimeModelOption[] | null>;
  /**
   * MCP server injection tag used by the launcher.
   * - `'none'`: no MCP server config injected (default when omitted).
   * - `'mature-acp'`: inject full ACP-style MCP server list (future story).
   */
  mcpDiscovery?: 'none' | 'mature-acp';
  /** True when the prompt is written to the child's stdin instead of argv. */
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  streamFormat: RuntimeStreamFormat;
  eventParser?: RuntimeEventParser;
  /**
   * Conversation continuity model (S-19 F0). `undefined` is treated as
   * `'native'`, so every existing adapter (claude, codex, cursor, copilot,
   * qoder, …) keeps its current resume-based behavior with no migration.
   * Only adapters whose CLI lacks a clean resume handle (gemini, opencode)
   * opt into `'replay'`, which makes the use case re-seed the prior
   * transcript into the prompt instead of relying on `agentSessionId`.
   * Hybrid by construction: a `'replay'` adapter can be promoted to
   * `'native'` later once its parser emits `session_started` and it defines
   * `buildResumeArgs`.
   */
  continuity?: RuntimeContinuity;
  /** Extra env vars to merge into the spawn environment. */
  env?: Record<string, string>;
  /** Allowlist of env keys the user can override per agent in Settings. */
  envOverrideKeys?: readonly string[];
  installUrl?: string;
  docsUrl?: string;
  /**
   * How this adapter receives the Devia system prompt (REV-AGENT-CORE-013):
   *   - 'argv'           — flag passed in `buildExtraArgs` (e.g. Claude's `--append-system-prompt`).
   *   - 'stdin-prepend'  — the launcher prepends a `[System] ... [User]` header
   *                        to the stdin payload before sending the user prompt.
   *   - 'argv-prepend'   — the agent reads the prompt from argv and has no
   *                        `--system` flag (e.g. Grok `-p`); the launcher inlines
   *                        the same `[System] ... [User]` header into the prompt
   *                        argv value (S-21 T-226). Counted against `maxPromptArgBytes`.
   *   - 'argv-file'      — the launcher writes the prompt to a per-run temp file
   *                        and appends `buildSystemPromptFileArgs(path)` (e.g. pi's
   *                        `--append-system-prompt <file>`). Keeps a large prompt
   *                        off the command line; the file is removed on exit.
   *   - 'unsupported'    — adapter has no system-prompt slot; the prompt is dropped
   *                        with a single debug-line warning.
   * UC-FIX-018: required so adding a new adapter without declaring the field
   * fails the typecheck rather than silently dropping system-prompt guardrails.
   */
  systemPromptStrategy: 'argv' | 'stdin-prepend' | 'argv-prepend' | 'argv-file' | 'unsupported';
  /** Required by `'argv-file'`: the flags that point the CLI at the prompt file. */
  buildSystemPromptFileArgs?: (file: string) => string[];
  /**
   * Declarative default denylist for tool names the adapter should never let
   * the agent invoke (REV-AGENT-CORE-007). Consumed by the use case when
   * minting `RunCapabilities`. User overrides from `DeviaConfig.agentToolPolicy`
   * extend (denylist-wins) but never widen.
   */
  defaultDisallowedTools?: string[];
  /**
   * Declarative default allowlist (REV-AGENT-CORE-007). When set, the run is
   * limited to these tool names (still subject to the denylist). `undefined`
   * means "all tools the adapter exposes".
   */
  defaultAllowedTools?: string[];
  /**
   * Builds the extra argv flags needed to resume a previously established
   * agent session. Only implemented by agents that support session resumption
   * (e.g. Claude Code uses `--resume <id>`). Agents that don't support
   * resumption leave this undefined — every run starts fresh for them.
   *
   * Called by the use case with the `agentSessionId` stored from a previous
   * `session_started` event. The use case appends the result to the spawn args.
   */
  buildResumeArgs?: (agentSessionId: string) => string[];
  /**
   * Per-adapter authentication probe (REV-AGENT-CORE-010). When defined the
   * detection layer calls it; otherwise `authStatus` is `'unknown'`. The
   * implementation must:
   *   - never throw (catch internally and return `{ status: 'unknown' }`)
   *   - respect a ~5s timeout
   *   - never log raw stdout (may contain partial tokens)
   */
  authProbe?: (
    resolvedBin: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<AuthProbeResult>;
  /**
   * Builds agent-specific extra argv flags for a run (e.g. permission mode,
   * disallowed tools, system-prompt injection). Replaces the previous
   * `buildClaudeOnlyExtraArgs` method in the use case — the use case calls
   * `def.buildExtraArgs?.(options) ?? []` generically without knowing the agent.
   */
  buildExtraArgs?: (options: AgentExtraArgsOptions) => string[];
}

/**
 * Result of probing an adapter's authentication status (REV-AGENT-CORE-010).
 *   - 'ok'      → agent is authenticated and ready to run.
 *   - 'missing' → agent is installed but not logged in; `message` carries
 *                 remediation hint safe to show in the UI.
 *   - 'unknown' → probe could not determine status (timeout, ENOENT, no probe
 *                 implemented).
 */
export interface AuthProbeResult {
  status: 'ok' | 'missing' | 'unknown';
  message?: string;
}

/** Options passed to `RuntimeAgentDef.buildExtraArgs`. */
export interface AgentExtraArgsOptions {
  systemPrompt: string;
  /**
   * Per-run permission descriptor (REV-AGENT-CORE-005). Adapters that emit
   * tool restrictions (e.g. Claude's `--disallowedTools`) compose them from
   * `capabilities.disallowedTools` / `capabilities.allowedTools`. Optional so
   * existing callers and tests that bypass the use case keep working.
   */
  capabilities?: import('../../../../shared/domain/run-capabilities').RunCapabilities;
  /**
   * Set when this run resumes a previous agent session. Adapters whose resume
   * SUBCOMMAND accepts a different flag surface than the fresh-run form use it
   * to re-shape mode flags (e.g. Codex `exec resume` rejects `--sandbox` but
   * accepts the `-c sandbox_mode=...` config override).
   */
  resumeSessionId?: string;
}

/**
 * Snapshot returned by detection: same as the def minus the build
 * machinery, plus runtime probe results. This is what the renderer sees.
 */
export interface DetectedAgent {
  id: string;
  name: string;
  bin: string;
  streamFormat: RuntimeStreamFormat;
  eventParser?: RuntimeEventParser;
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  reasoningOptions?: RuntimeReasoningOption[];
  envOverrideKeys?: readonly string[];
  installUrl?: string;
  docsUrl?: string;
  models: RuntimeModelOption[];
  available: boolean;
  /**
   * Provider integration type echoed back so the renderer can label
   * non-CLI providers and avoid pretending an API/MCP entry is "installed".
   * Always set by the detector (defaults to `'cli'` when the def omits it).
   */
  providerType: RuntimeProviderType;
  /** Applicability echoed back for the UI. */
  applicability: RuntimeApplicability;
  /**
   * For non-CLI providers: `true` when the user has supplied every
   * `requiredEnvKeys` value (api/local-model) or `requiredConfigKeys`
   * entry (mcp). Never carries the values themselves — secrets stay in
   * the main process.
   */
  configured?: boolean;
  /**
   * Human-readable reason explaining why `available` is `false` (or why
   * an `available` provider is still not selectable, e.g. planned).
   * Safe to render verbatim — no secrets, no host paths beyond what the
   * existing `path` field already exposes.
   */
  unavailableReason?: string;
  /**
   * `true` when the user can pick this provider as the active agent.
   * Equal to `available && providerType === 'cli'` today. Computed by
   * the detector so the renderer doesn't have to reproduce the rule.
   */
  selectable: boolean;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  /**
   * Human-readable note surfaced when the native binary resolution for this
   * agent failed (e.g. Codex on Windows without `@openai/codex-win32-x64`).
   * Shown as a diagnostic callout in the Settings modal.
   */
  diagnostic?: string;
  /**
   * Actual binary path used for version probing and auth probing — may differ
   * from `def.bin` when the agent is installed via a version manager or when
   * the Codex native binary was located via `resolveAgentBin`.
   */
  resolvedBin?: string;
  path?: string;
  version?: string | null;
}
