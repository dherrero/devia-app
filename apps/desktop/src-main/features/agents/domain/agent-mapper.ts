import type { ChildProcess } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';

import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { RuntimeAgentDef } from '../../cli-adapters/domain/runtime-agent-def';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import type { AgentRunPlan, HarnessKind } from './agent-run-plan';

/**
 * Contract B (core ↔ mappers, S-30): the port every CLI agent implements.
 *
 *   render ──[A: shared/contracts]──▶ core ──[B: AgentMapper]──▶ mapper ──[C: wire/<id>]──▶ CLI
 *
 * TWO phases on purpose. The system prompt has to announce exactly the tools
 * the run will HAVE (S-25: announcing an undelivered blocking tool hangs the
 * run; teaching the fallback for a delivered one wastes context), and what a
 * run has depends on the agent — an enterprise MCP policy, a CLI without MCP,
 * a failed config write. So:
 *
 *   1. `resolveDelivery(plan)`             → what will reach the agent, by which channel
 *   2. core composes the system prompt from that resolution
 *   3. `prepareRun(plan, systemPrompt)`    → argv / stdin / env / temp files
 *   4. launcher spawns, `openSession(io)`  → decode the stream, answer the agent
 *
 * Where each agent-specific branch of the old use case lives now:
 *
 * | old `RunInstructionUseCase` branch                         | mapper method         |
 * | ---------------------------------------------------------- | --------------------- |
 * | enterprise MCP policy (T-88)                               | resolveDelivery       |
 * | `devia-ui` delivered? (claude/pi per run, others native)   | resolveDelivery       |
 * | `--mcp-config` + `--strict-mcp-config` + grants (Claude)   | prepareRun            |
 * | `-e` extension + `.pi/mcp.json` retirement (pi)            | prepareRun            |
 * | native-config injectors memory/kanban/ui + devia-ask retire| prepareRun            |
 * | `ensureCodexTrust`                                         | prepareRun            |
 * | `Workflow` disallow outside plan (Claude)                  | prepareRun            |
 * | legacy AskUserQuestion hook / grant sweep (Claude)         | prepareRun            |
 * | system prompt channel (argv / stdin-prepend / file / none) | prepareRun            |
 * | resume flags / subcommand                                  | prepareRun            |
 * | env for the CLI (Claude ANTHROPIC_* handling)              | prepareRun            |
 * | stream parser / RPC driver selection                       | openSession           |
 * | pi `extension_ui_request`, ACP permission requests         | openSession (ui_request) |
 * | answer routing (stream-json tool_result, pi, ACP)          | AgentSession.answer   |
 */
export interface AgentMapper {
  readonly id: string;
  /** Static descriptor: name, binary, models, auth probe, detection. */
  readonly def: RuntimeAgentDef;
  /** How this agent can receive each part of Devia's harness. */
  readonly harnessSupport: HarnessSupport;
  /**
   * Whether the CLI can be told to load ONLY Devia's MCP servers (S-1 T-15
   * external-memory isolation — Claude's `--strict-mcp-config`).
   */
  readonly isolatesExternalMcp: boolean;
  /**
   * Built-in tools this agent must not be offered in `mode`, on top of the
   * user's policy (e.g. Claude's `Workflow` outside plan — S-16 T-189). Feeds
   * the run's capabilities BEFORE the plan is built.
   */
  disallowedTools(mode: RunMode): readonly string[];
  resolveDelivery(plan: AgentRunPlan): DeliveryResolution;
  prepareRun(plan: AgentRunPlan, systemPrompt: string, delivery: DeliveryResolution): PrepareResult;
  openSession(io: AgentSessionIo, plan: AgentRunPlan): AgentSession;
}

/**
 * - `native`  the CLI receives it through its own mechanism (flag, config, extension).
 * - `devia`   Devia delivers it through its own channel (an MCP tool, a prompt hint).
 * - `none`    cannot be delivered; the core must not announce it.
 */
export type HarnessChannel = 'native' | 'devia' | 'none';
export type HarnessSupport = Readonly<Record<HarnessKind, HarnessChannel>>;

/** Phase 1 result: what will actually reach the agent. */
export interface DeliveryResolution {
  /** MCP server ids (Devia's and the user's) the agent will be able to call. */
  readonly mcpServerIds: readonly string[];
  readonly skills: HarnessChannel;
  readonly subagents: HarnessChannel;
  /** One-line status messages for the user (e.g. "enterprise policy: no Devia MCP"). */
  readonly notices: readonly string[];
}

/** How the prompt reaches the CLI's stdin. */
export type StdinPlan =
  /** Nothing on stdin (prompt in argv). */
  | { readonly kind: 'none' }
  /** Write once and close. */
  | { readonly kind: 'text'; readonly payload: string }
  /** Write and keep open: the session writes more later (Claude stream-json). */
  | { readonly kind: 'stream'; readonly payload: string }
  /** The session driver owns stdin entirely (pi RPC, ACP). */
  | { readonly kind: 'session' };

/**
 * Phase 2 outcome. A preparation can refuse to run (e.g. the prompt does not
 * fit an argv-bound CLI's command line); the core reports `error` as the run
 * failure without spawning anything.
 */
export type PrepareResult =
  | { readonly ok: true; readonly run: PreparedRun }
  | { readonly ok: false; readonly error: string };

/** Phase 2 result: everything the launcher needs to spawn, and nothing more. */
export interface PreparedRun {
  /** Full argv after the binary. */
  readonly args: readonly string[];
  readonly stdin: StdinPlan;
  /** The user's env overrides for this agent — the launcher filters them through the def's allowlist. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The mapper's own env (e.g. where a per-run config lives). Trusted and NOT
   * user-settable, so it bypasses the allowlist and wins over the overrides.
   */
  readonly agentEnv?: Readonly<Record<string, string>>;
  /**
   * MCP server ids actually materialised. Can be narrower than the delivery
   * resolution when a temp-file write fails; the core then stops serving the
   * tools of a server that never reached the agent.
   */
  readonly mcpServerIds: readonly string[];
  /** Removes every temp artifact this preparation created. Idempotent. */
  cleanup(): void;
  readonly notices: readonly string[];
}

/** A dialog the AGENT itself raised (pi extension UI, ACP permission). */
export interface AgentUiRequest {
  readonly callId: string;
  readonly kind: 'confirm' | 'select' | 'input';
  /**
   * `permission`: the agent asks leave to run a tool (ACP). Never auto-answered
   * on a remote run — approving or denying blindly would be unsafe.
   */
  readonly purpose?: 'question' | 'permission';
  readonly title: string;
  readonly message?: string;
  readonly options?: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
}

/** The user's answer to a card, in Devia's terms — each session translates it. */
export type AgentAnswer =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'confirm'; readonly confirmed: boolean }
  | { readonly kind: 'select'; readonly value: string }
  | { readonly kind: 'cancel' };

/** What the launcher hands a session once the process is up. */
export interface AgentSessionIo {
  /** The spawned CLI, for RPC drivers that own its lifecycle (pi, ACP). */
  readonly process: ChildProcess;
  readonly stdin: Writable | null;
  readonly stdout: Readable;
  /** Canonical events towards the core (contract A shapes). */
  emit(event: AgentEvent): void;
  /**
   * A dialog the agent raised natively; the core draws the card. False when
   * nothing can draw it — the session then applies its headless default
   * rather than leave the agent waiting forever.
   */
  requestUi(request: AgentUiRequest): boolean;
}

export interface AgentSession {
  /** Drain any buffered partial output once the process has exited. */
  flush(): void;
  /**
   * Deliver an answer through the agent's NATIVE channel. Returns false when
   * `callId` is not one of this session's own requests (the core then uses
   * Devia's rendezvous for `devia-ui` tools).
   */
  answer(callId: string, answer: AgentAnswer): boolean;
  /** Ask the agent to stop cleanly before the launcher's SIGTERM fallback. */
  abort(): void;
}
