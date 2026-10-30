import type { CliAdapterRegistry } from '../domain/ports';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';
import { claudeAgentDef } from './defs/claude';
import { codexAgentDef } from './defs/codex';
import { geminiAgentDef } from './defs/gemini';
import { opencodeAgentDef } from './defs/opencode';
import { cursorAgentDef } from './defs/cursor-agent';
import { copilotAgentDef } from './defs/copilot';
import { qwenAgentDef } from './defs/qwen';
import { deepseekAgentDef } from './defs/deepseek';
import { qoderAgentDef } from './defs/qoder';
import { grokAgentDef } from './defs/grok';
import { kimiAgentDef } from './defs/kimi';
import { hermesAgentDef } from './defs/hermes';
import { piAgentDef } from './defs/pi';

/**
 * Catalog of every CLI Devia knows how to drive. Order is preserved in
 * the Settings picker so the default agent (claude) appears first.
 *
 * REV-AGENT-CORE-008: cursor-agent + Copilot added.
 *
 * The catalog is split into two tiers:
 *   1. Fully integrated CLI adapters (Claude…Copilot) with custom event
 *      stream parsers.
 *   2. Adapted CLI adapters (Qwen, DeepSeek, Qoder) wired to the
 *      plain-text parser pending dedicated stream support. They are
 *      detected via PATH like the first tier.
 *
 * The previous "planned" tier (direct APIs, local-model runtimes, ACP /
 * JSON-RPC agents surfaced as informational-only entries) was removed:
 * the catalog now lists only executable CLI agents.
 */
export const AGENT_DEFS: readonly RuntimeAgentDef[] = Object.freeze([
  // Tier 1 — first-class CLI adapters.
  claudeAgentDef,
  codexAgentDef,
  geminiAgentDef,
  opencodeAgentDef,
  cursorAgentDef,
  copilotAgentDef,
  grokAgentDef,
  // Tier 2 — adapted CLI adapters (detection-first, plain-text streaming).
  qwenAgentDef,
  deepseekAgentDef,
  qoderAgentDef,
  // Stdio JSON-RPC agents (driven by dedicated session drivers).
  kimiAgentDef,   // ACP
  hermesAgentDef, // ACP
  piAgentDef,     // pi-rpc
]);

// ── Startup duplicate-id invariant ────────────────────────────────────────────
// Runs at module load time so any accidental duplicate introduced during
// development fails the process before IPC registration rather than silently
// shadowing one definition.

/**
 * Asserts that the provided agent definitions contain no duplicate ids.
 * Exported so tests can exercise the guard with arbitrary inputs.
 * @throws {Error} Duplicate agent definition id: <id>
 */
export function assertNoDuplicateIds(defs: readonly RuntimeAgentDef[]): void {
  const seenIds = new Set<string>();
  for (const def of defs) {
    if (seenIds.has(def.id)) {
      throw new Error(`Duplicate agent definition id: ${def.id}`);
    }
    seenIds.add(def.id);
  }
}

assertNoDuplicateIds(AGENT_DEFS);

/**
 * UC-FIX-018: warns at startup when a CLI provider explicitly declares
 * `systemPromptStrategy: 'unsupported'`. System-prompt guardrails will be
 * silently dropped for those adapters during every run. Exported for tests.
 */
export function warnUnsupportedSystemPromptStrategy(defs: readonly RuntimeAgentDef[]): void {
  for (const def of defs) {
    const providerType = def.providerType ?? 'cli';
    if (providerType === 'cli' && def.systemPromptStrategy === 'unsupported') {
      console.warn(
        `[registry] CLI adapter "${def.id}" declares systemPromptStrategy:'unsupported' — ` +
        `system-prompt guardrails will be dropped for this agent.`,
      );
    }
  }
}

warnUnsupportedSystemPromptStrategy(AGENT_DEFS);

export class StaticCliAdapterRegistry implements CliAdapterRegistry {
  /** Mutable list of runtime-registered defs. Never overlaps with AGENT_DEFS ids. */
  private readonly _additionalDefs: RuntimeAgentDef[] = [];

  all(): readonly RuntimeAgentDef[] {
    return [...AGENT_DEFS, ...this._additionalDefs];
  }

  get(id: string): RuntimeAgentDef | null {
    return (
      AGENT_DEFS.find((def) => def.id === id) ??
      this._additionalDefs.find((def) => def.id === id) ??
      null
    );
  }

  /**
   * Appends validated user-supplied defs to the in-memory catalog.
   *
   * Rules:
   * - Entries missing `id` or `bin` are logged and skipped (no throw).
   * - Entries whose `id` already exists in `AGENT_DEFS` or in the already-
   *   registered additional list are logged and skipped (no throw).
   * - `AGENT_DEFS` is never mutated.
   */
  registerAdditional(defs: RuntimeAgentDef[]): void {
    for (const def of defs) {
      if (!def.id || !def.bin) {
        console.warn('[registry] skipping additional def: missing id or bin', def);
        continue;
      }
      if (this.get(def.id) !== null) {
        console.warn(`[registry] skipping additional def: duplicate id "${def.id}"`);
        continue;
      }
      this._additionalDefs.push(def);
      console.log(`[registry] registered additional agent: "${def.id}" (${def.bin})`);
    }
  }

  /**
   * Returns the `installUrl` and `docsUrl` for a known agent id.
   * Returns an empty object when the id is not in the catalog.
   */
  installMetaForAgent(id: string): { installUrl?: string; docsUrl?: string } {
    const def = this.get(id);
    if (!def) return {};
    const meta: { installUrl?: string; docsUrl?: string } = {};
    if (def.installUrl) meta.installUrl = def.installUrl;
    if (def.docsUrl) meta.docsUrl = def.docsUrl;
    return meta;
  }
}

export { DEFAULT_AGENT_ID } from '../../../../shared/domain/agent';
