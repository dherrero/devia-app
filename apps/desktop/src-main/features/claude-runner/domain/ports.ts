import type { ProjectRegistry } from '../../../shared/ports';
import type { CancelReason, ErrorClassification } from '../../../../shared/domain/agent-event';
import type { ClassifiedError } from '../../../../shared/domain/cli-errors';
import type { RunId } from '../../../../shared/domain/agent';
import type { AgentAnswer, AgentUiRequest, SkillRef, SubagentRef } from '../../agents/domain';

/**
 * The part of Devia's harness that is NOT an MCP server: the skills and the
 * sub-agents Devia manages (S-30 T-356). Devia — not each CLI's own config — is
 * their source of truth, and they travel with every run.
 */
export interface HarnessCatalog {
  /** Skills visible from `cwd`: project ones first, then the user's global ones. */
  skills(cwd: string): SkillRef[];
  /** Enabled sub-agents of the project (Devia's `.devia/sub-agents`). */
  subagents(projectCheckout: string): SubagentRef[];
}

/**
 * Handlers the runner calls as the agent's child process makes progress.
 * `onOutput` receives serialised canonical `AgentEvent`s (each agent's mapper
 * decodes its own wire — S-30 contract A). `onDone` fires only on a clean
 * exit; non-zero exits go through `onError` with a user-facing message
 * (typically the tail of stderr).
 */
export interface AgentRunHandlers {
  onOutput(line: string): void;
  onDone(code: number): void;
  /**
   * Called on non-zero exit or spawn failure.
   * `classification` is the legacy 5-value result of `classifyError`.
   * `classifiedError` is the richer recovery-action taxonomy from
   * E-DSK-09 #262, forwarded onto `process:end` so the renderer can
   * route the right UX path (settings deep link / upgrade toast /
   * cooldown indicator).
   * `signal` is set when the process was killed by a signal (e.g. `'SIGTERM'`).
   * `cancelReason` is set when the run was deliberately terminated
   * (REV-AGENT-CORE-011) — see `CancelReason` for the enumerated causes.
   */
  onError(
    message: string,
    classification?: ErrorClassification,
    signal?: string,
    cancelReason?: CancelReason,
    classifiedError?: ClassifiedError,
  ): void;
  /**
   * A dialog the agent raised natively (ACP permission, pi extension UI),
   * already translated to Devia's terms by its mapper. Return true when a card
   * will be drawn; false lets the session apply its headless default.
   */
  onUiRequest(request: AgentUiRequest): boolean;
}

/** The runner's handle on one spawned agent. */
export interface AgentProcessHandle {
  /**
   * Terminate the child process. The optional `reason` is captured by the
   * launcher and forwarded to `onError` as the `cancelReason` so the renderer
   * can distinguish user cancel vs idle vs question-timeout (REV-AGENT-CORE-011).
   */
  kill(reason?: CancelReason): void;
  /** Answer through the agent's native channel; false when nothing was pending. */
  answer(callId: string, answer: AgentAnswer): boolean;
}

/**
 * What the registry holds per running project. `writeToolResult` is the IPC
 * entry point for the user's answer to ANY card (the renderer sends a string);
 * the use case routes it to Devia's rendezvous or the agent's native channel.
 */
export interface ProcessHandle {
  kill(reason?: CancelReason): void;
  writeToolResult?(toolUseId: string, content: string): void;
}

/**
 * Internal extension of the shared `ProjectRegistry` port: lets the runner
 * use case attach/detach the actual `ProcessHandle` so cross-feature callers
 * (workspace → stopProject) can kill it without knowing the runner's
 * details.
 */
export interface ProcessTrackingRegistry extends ProjectRegistry {
  /**
   * Attach a process handle to the given project. The optional `runId` is
   * stored alongside the handle so callers can later look the process up by
   * runId (e.g. for targeted cancellation).
   */
  attachProcess(projectPath: string, handle: ProcessHandle, runId?: RunId): void;
  detachProcess(projectPath: string): void;
  /**
   * Write a tool_result to the running process's stdin (multi-turn protocol).
   * No-op if the project has no attached process or the handle lacks the method.
   */
  writeToolResult(projectPath: string, toolUseId: string, content: string): void;
  /**
   * Cancel a specific run by id. Sends SIGTERM if the process is still active;
   * returns silently if no project is currently running that runId
   * (REV-AGENT-CORE-001). The optional `reason` is forwarded to the launcher
   * so the renderer can distinguish user/idle/question-timeout cancellations
   * (REV-AGENT-CORE-011); defaults to `'user'` when omitted.
   */
  cancelRun(runId: RunId, reason?: CancelReason): void;
}
