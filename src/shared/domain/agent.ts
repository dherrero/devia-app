/**
 * Renderer-visible projection of `RuntimeAgentDef` + detection results.
 * Kept in `shared/domain/` so both sides of the IPC bridge share one
 * type without the renderer having to import anything from `src/main/`
 * (which would pull in `node:` modules the renderer can't see).
 */
import type { BillingMode } from './billing';

/**
 * Branded UUID v4 identifying a single agent run.
 *
 * Distinct from `agentSessionId` (which is the agent's own session token, e.g.
 * Claude Code's session UUID used with `--resume`) and from `activeSessionId`
 * (which is Devia's internal session id for chat persistence).
 *
 * A `runId` is minted by `RunInstructionUseCase.execute()` for every spawn and
 * remains valid only while that one child process is alive. Carried on every
 * IPC event emitted to the renderer so concurrent runs (or rapid stop/start
 * cycles) never interleave events on the wrong message.
 */
export type RunId = string & { readonly __brand: 'RunId' };

/**
 * Returns true when `eventRunId` belongs to a different run than `streamRunId`
 * and the event should be discarded.
 *
 * Rules:
 *  - If the stream has no runId (legacy), accept every event.
 *  - If the stream has a runId but the event does not, treat the event as
 *    foreign (it was emitted without tagging — could be stale).
 *  - If both carry a runId, compare them.
 */
export function isForeignEvent(
  streamRunId: RunId | undefined,
  eventRunId: RunId | undefined,
): boolean {
  if (streamRunId === undefined) return false;
  if (eventRunId === undefined) return true;
  return eventRunId !== streamRunId;
}

export interface AgentModelOption {
  id: string;
  label: string;
}

export type AgentReasoningOption = AgentModelOption;

export type AgentStreamFormat =
  | 'plain'
  | 'claude-stream-json'
  | 'json-event-stream'
  | 'acp-json-rpc'
  | 'pi-rpc';

/**
 * Provider integration type echoed across the IPC bridge. Mirrors
 * `RuntimeProviderType` from `src/main` so the renderer can render
 * non-CLI providers (api, mcp, local-model, planned) without importing
 * any node-only modules.
 */
export type AgentProviderType =
  | 'cli'
  | 'api'
  | 'mcp'
  | 'local-model'
  | 'planned';

/** Mirror of `RuntimeApplicability`. */
export type AgentApplicability =
  | 'direct'
  | 'adapted'
  | 'planned'
  | 'not-applicable';

/**
 * What an agent can receive of Devia's harness, and by which channel
 * (S-30 contract A). Comes from the agent's mapper, so the renderer never keeps
 * its own per-agent capability lists.
 *   native  the CLI's own mechanism; devia  Devia's channel (an MCP tool);
 *   none    not deliverable to this agent.
 */
/** The agent Devia selects when none is configured — shared by main and renderer. */
export const DEFAULT_AGENT_ID = 'claude';

export interface AgentHarnessView {
  mcp: 'native' | 'devia' | 'none';
  skills: 'native' | 'devia' | 'none';
  subagents: 'native' | 'devia' | 'none';
  /** Whether the agent can load ONLY Devia's MCP servers (external memory isolation). */
  isolatesExternalMcp: boolean;
}

export interface DetectedAgentView {
  id: string;
  name: string;
  bin: string;
  streamFormat: AgentStreamFormat;
  eventParser?: string;
  promptViaStdin?: boolean;
  promptInputFormat?: 'text' | 'stream-json';
  reasoningOptions?: AgentReasoningOption[];
  envOverrideKeys?: string[];
  installUrl?: string;
  docsUrl?: string;
  models: AgentModelOption[];
  available: boolean;
  /**
   * Always set: tells the UI whether this is a CLI binary, a direct API
   * provider, an MCP server, a local model, or a planned-only entry.
   */
  providerType: AgentProviderType;
  /** Always set; defaults to `'direct'` for built-in CLI adapters. */
  applicability: AgentApplicability;
  /** `true` when the user has set every required env/config key. */
  configured?: boolean;
  /** Reason this entry is unavailable / not selectable, safe to render. */
  unavailableReason?: string;
  /** `true` when the user is allowed to pick this provider as active. */
  selectable: boolean;
  /** Harness capabilities from the agent's mapper; absent for non-CLI providers. */
  harness?: AgentHarnessView;
  authStatus?: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
  /**
   * Human-readable note surfaced when native binary resolution failed
   * (e.g. Codex on Windows). Shown as a diagnostic callout in the Settings modal.
   */
  diagnostic?: string;
  /**
   * Actual binary path used for probing — may differ from `bin` when the agent
   * is installed via a version manager (nvm, mise) or Codex native binary.
   */
  resolvedBin?: string;
  path?: string;
  version?: string | null;
  /** Billing mode for the agent (S-1 T-2). Optional for backward compat with
   *  older payloads; absent treated as 'unknown' in the renderer. */
  billingMode?: BillingMode;
}

export interface AgentChangedEvent {
  agentId: string;
}

export interface SetAgentModelInput {
  agentId: string;
  model?: string | null;
  reasoning?: string | null;
}

export interface SetAgentEnvInput {
  agentId: string;
  env: Record<string, string>;
}

export interface TestAgentResult {
  available: boolean;
  version?: string | null;
  path?: string;
  message?: string;
}
