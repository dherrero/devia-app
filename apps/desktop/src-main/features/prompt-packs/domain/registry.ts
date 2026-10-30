import type { PromptPack, PromptPackSummary } from '../../../../shared/domain/prompt-pack';

/**
 * In-memory registry of available prompt packs (REV-AGENT-CORE-003).
 *
 * Loaded once at startup from the user dir + bundled dir. The use case calls
 * `getBodies(ids)` to compose the per-turn system prompt.
 */
export class PromptPackRegistry {
  private readonly packs: Map<string, PromptPack> = new Map();

  constructor(initial: readonly PromptPack[] = []) {
    for (const p of initial) this.packs.set(p.id, p);
  }

  /** Replace the entire catalog (used on re-scan). */
  set(packs: readonly PromptPack[]): void {
    this.packs.clear();
    for (const p of packs) this.packs.set(p.id, p);
  }

  /** Renderer-facing list (no bodies). */
  list(): PromptPackSummary[] {
    const out: PromptPackSummary[] = [];
    for (const p of this.packs.values()) {
      const s: PromptPackSummary = {
        id: p.id,
        name: p.name,
        description: p.description,
        source: p.source,
      };
      if (p.triggers !== undefined) s.triggers = p.triggers;
      out.push(s);
    }
    return out;
  }

  /** Returns the bodies of the requested packs in the order requested.
   *  Unknown ids are silently dropped (FR §15). */
  getBodies(ids: readonly string[]): string[] {
    const bodies: string[] = [];
    for (const id of ids) {
      const p = this.packs.get(id);
      if (p) bodies.push(p.body);
    }
    return bodies;
  }

  get(id: string): PromptPack | undefined {
    return this.packs.get(id);
  }

  size(): number {
    return this.packs.size;
  }
}
