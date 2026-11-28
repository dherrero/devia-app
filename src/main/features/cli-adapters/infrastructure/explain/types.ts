import type { ClassifiedError } from '../../../../../shared/domain/cli-errors';
import type { UserFacingError } from '../../../../../shared/domain/user-facing-error';

/** What the run knows that the raw error text does not. Names only, never secret values. */
export interface ExplainContext {
  readonly agentId: string;
  /** Model saved for this agent in Settings › Execution (undefined or empty = none). */
  readonly configuredModel?: string;
  /** NAMES of provider credential variables present in Devia's environment (e.g. `OPENAI_API_KEY`). */
  readonly inheritedProviderEnv: readonly string[];
  readonly autoContinueEnabled?: boolean;
  /** Epoch ms the usage limit lifts, when the agent reported it. */
  readonly resetsAt?: number;
  readonly origin: 'renderer' | 'remote';
}

export interface ExplainInput {
  readonly classified: ClassifiedError;
  readonly ctx: ExplainContext;
}

/**
 * An agent's own reading of its errors. Returns `null` to defer to the generic
 * mapping; never throws (the facade guards it anyway).
 */
export type AgentExplainer = (input: ExplainInput) => UserFacingError | null;
