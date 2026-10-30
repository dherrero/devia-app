import type { McpServerConfig } from '../../../../shared/domain/mcp';
import type { RunCapabilities, RunMode } from '../../../../shared/domain/run-capabilities';

/**
 * What the core WANTS from one agent run — the input side of contract B
 * (core ↔ mappers, S-30).
 *
 * Everything here is agent-agnostic: the core decides WHAT is asked (mode,
 * prompt, the harness Devia manages, resume handle, budgets) and never HOW a
 * given CLI receives it. Turning this into argv / stdin / env / files is the
 * job of that agent's `AgentMapper`.
 */
export interface AgentRunPlan {
  readonly runId: string;
  readonly agentId: string;
  readonly mode: RunMode;
  /** Effective working directory (a per-session worktree when isolated). */
  readonly cwd: string;
  /** Base checkout: the identity of memory / kanban / grants (never a worktree). */
  readonly projectCheckout: string;
  /** Devia's data dir — where mappers put per-run temp artifacts. */
  readonly deviaDir: string;
  /** The user turn exactly as the agent must receive it (replay / handoff
   *  already folded in by the core). */
  readonly prompt: string;
  readonly imagePaths: readonly string[];
  /** Directories beyond `cwd` the run may reach (confined modes only). */
  readonly extraAllowedDirs: readonly string[];
  /** Native session to continue, already checked to belong to this agent. */
  readonly resumeSessionId?: string;
  readonly model?: string | null;
  readonly reasoning?: string | null;
  /** Allowlist-validated env overrides the user set for this agent. */
  readonly envOverrides: Readonly<Record<string, string>>;
  readonly capabilities: RunCapabilities;
  /** Telegram / remote origin: no interactive UI beyond the remote-safe tools. */
  readonly isRemote: boolean;
  readonly harness: HarnessPlan;
  /** Devia's interface-card rendezvous for this run (S-25), agent-agnostic. */
  readonly ui: {
    /** Per-run directory the `devia-ui` server and the core meet in. */
    readonly rendezvousDir: string;
    /** How long a blocking card may wait before the run is killed. */
    readonly toolTimeoutMs: number;
  };
}

/**
 * The harness Devia manages and that must TRAVEL with the run to whichever
 * agent is active (S-30 T-356: Devia — not the CLI's own config — is the
 * source of truth). A mapper delivers each piece natively when its CLI can,
 * and through Devia's own channel (an MCP tool, a prompt hint) when it cannot.
 */
export interface HarnessPlan {
  readonly mcp: {
    /** Devia's bundled servers (devia-kanban, devia-memory, devia-ui). */
    readonly devia: readonly McpServerConfig[];
    /** Servers the user enabled in Devia's MCP manager. */
    readonly user: readonly McpServerConfig[];
  };
  readonly skills: readonly SkillRef[];
  readonly subagents: readonly SubagentRef[];
  /** Load ONLY Devia's MCP servers (S-1 T-15) where the CLI can enforce it. */
  readonly isolateExternalMcp: boolean;
}

/** A skill Devia knows about: a directory holding a `SKILL.md`. */
export interface SkillRef {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the skill directory. */
  readonly dir: string;
}

/** A sub-agent definition Devia knows about (a `.claude/agents/*.md`-style file). */
export interface SubagentRef {
  readonly name: string;
  readonly description: string;
  /** Absolute path of the definition file (markdown with front-matter). */
  readonly file: string;
}

export type HarnessKind = 'mcp' | 'skills' | 'subagents';
