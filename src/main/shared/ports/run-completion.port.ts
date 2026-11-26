/**
 * Wait for a run to end and collect what the assistant said (S-56).
 *
 * The whole run pipeline is push (events to the renderer); a cross-agent
 * worker needs pull: "resolve when this run is over, with its final text".
 */
export interface RunOutcome {
  status: 'done' | 'failed' | 'cancelled' | 'timeout';
  /** Assistant prose only: tool calls and thinking are not part of the report. */
  finalText: string;
  error?: string;
}

export interface RunCompletionOptions {
  /** Resolve `timeout` after this long. Absent = wait forever. */
  timeoutMs?: number;
  /** Called on timeout, before resolving: the caller kills the run here. */
  onTimeout?: () => void;
}

export interface RunCompletion {
  /** `runKey` is the run identity events are routed by (`project` of a gateway event). */
  await(runKey: string, opts?: RunCompletionOptions): Promise<RunOutcome>;
}
