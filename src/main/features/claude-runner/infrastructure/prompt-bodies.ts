/**
 * The bodies the core appends to the base system prompt, one field per source
 * (S-40). Null means "this run has none of it".
 */
export interface PromptBodies {
  readonly packs: readonly string[];
  readonly skillRegistry: string | null;
  readonly kit: string | null;
  readonly memoryProtocol: string | null;
  readonly memoryContext: string | null;
  readonly handoff: string | null;
  readonly worktree: string | null;
  readonly remote: string | null;
  readonly uiFallback: string | null;
  readonly plan: string | null;
}

const present = (...bodies: readonly (string | null)[]): string[] => bodies.filter((b): b is string => b !== null);

/**
 * Every body, in the order the full system prompt has always carried them
 * (packs, skill registry, kit, memory protocol, memory context, handoff,
 * worktree, remote, UI fallback, plan). Agents that re-send the whole prompt on
 * every run keep receiving exactly this.
 */
export function orderedBodies(b: PromptBodies): string[] {
  return [
    ...b.packs,
    ...present(b.skillRegistry, b.kit, b.memoryProtocol, b.memoryContext, b.handoff, b.worktree, b.remote, b.uiFallback, b.plan),
  ];
}

/**
 * For a CLI that keeps the first turn's system prompt (S-40): what is true for
 * the whole session goes in the prompt (`stable`), what can differ from one turn
 * to the next travels in the user turn (`turn`). The memory context is stable on
 * the first turn and a post-compaction re-injection afterwards. Both lists keep
 * the relative order of `orderedBodies`.
 */
export function splitBodies(b: PromptBodies, opts: { readonly firstTurn: boolean }): { stable: string[]; turn: string[] } {
  const memoryInStable = opts.firstTurn;
  return {
    stable: [
      ...b.packs,
      ...present(b.skillRegistry, b.kit, b.memoryProtocol, memoryInStable ? b.memoryContext : null, b.handoff),
    ],
    turn: present(memoryInStable ? null : b.memoryContext, b.worktree, b.remote, b.uiFallback, b.plan),
  };
}
