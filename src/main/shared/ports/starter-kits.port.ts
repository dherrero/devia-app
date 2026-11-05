/**
 * What the run core needs from a starter kit (S-38/S-39). The core is
 * agent-agnostic: it never asks which kit or which agent, it appends the text
 * and passes the directories along. Implemented by `features/starter-kits`.
 */
export interface StarterKitRun {
  id: string;
  /** Materialised, read-only kit root (a complete plugin: manifest + skills). */
  dir: string;
  /** `<dir>/skills`: served by `devia_skill` after the project's and the user's own skills. */
  skillsDir: string;
  /** The kit's bootstrap and skill index, appended to the system prompt of every agent. */
  prompt: string;
}

export interface StarterKitsPort {
  /** `null` when no kit applies: disabled, not materialised, or the agent already has it natively. */
  resolve(ctx: { agentId: string; projectCheckout: string; cwd: string }): StarterKitRun | null;
}
