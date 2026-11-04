/**
 * What the run core needs from a starter kit (S-38). The core is
 * agent-agnostic: it never asks which kit or which agent, it just composes the
 * text and passes the directories along. Implemented by `features/starter-kits`.
 */
export interface StarterKitRun {
  id: string;
  /** Materialised, read-only kit root (a complete plugin: manifest + hooks + skills). */
  dir: string;
  /** `<dir>/skills`: served by `devia_skill` after the project's and the user's own skills. */
  skillsDir: string;
  /** The kit's own session bootstrap, for agents that cannot load the kit natively. */
  bootstrap: string;
  /** Devia's mapping from the kit's actions to Devia's tools. Always delivered. */
  protocol: string;
}

export interface StarterKitsPort {
  /** `null` when no kit applies: disabled, not materialised, or the agent already has it natively. */
  resolve(ctx: { agentId: string; projectCheckout: string; cwd: string }): StarterKitRun | null;
}
