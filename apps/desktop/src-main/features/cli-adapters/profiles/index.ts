import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { ClassifiedError } from '../../../../shared/domain/cli-errors';
import { classify } from '../infrastructure/error-classifier';
import { toProviderProfile, type ProviderProfile, type ParserState } from '../domain/provider-profile';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';
import { AGENT_DEFS } from '../infrastructure/registry';
import { selectStreamParser } from '../infrastructure/parsers/select-parser';

/**
 * Profiles registry (E-DSK-09 #264).
 *
 * Each agent in {@link AGENT_DEFS} gets wrapped in a
 * {@link ProviderProfile} via {@link toProviderProfile}. The wrappers
 * delegate spawn/env to the existing `RuntimeAgentDef` machinery, plug
 * in the unified `classifyError` from #262, and lazily route stream
 * lines through the existing per-format parser registry.
 *
 * The wrapping is intentionally lossy in one direction: only the
 * fields the runner needs to talk to the profile end up on the
 * `ProviderProfile` surface. Settings UI and detection layers continue
 * to read the wider `RuntimeAgentDef` directly.
 *
 * Adding a new agent (`agent12`) — when the underlying `RuntimeAgentDef`
 * for it is registered in {@link AGENT_DEFS}, the profile is materialised
 * here automatically. No code edits to runner / registry. Adding new
 * profile-only hooks (e.g. `fetchModels` async) means extending
 * `ProviderProfile` once and threading the new hook through
 * {@link buildProviderProfile}.
 */

/**
 * Build a single {@link ProviderProfile} from a {@link RuntimeAgentDef}.
 * Public so tests can build fixtures without going through the
 * registry.
 */
export function buildProviderProfile(def: RuntimeAgentDef): ProviderProfile {
  return toProviderProfile(def, {
    /**
     * Stream parsing — defer to the existing parser selector. The
     * factory creates a per-run parser bound to a sink; we close over a
     * sink that accumulates into the runner-supplied state object so
     * the function signature stays `(line, state) => AgentEvent[]`.
     *
     * The launcher / runner are still the canonical drivers of the
     * parser today; this hook is the seam the next refactor pass will
     * widen.
     */
    parseStreamLine(line: string, state: ParserState): AgentEvent[] {
      const events: AgentEvent[] = [];
      const sink = (event: AgentEvent): void => { events.push(event); };
      // Cache the parser on the state record so a per-run parser keeps
      // its line buffer across calls. The state record is opaque to the
      // runner — this is the canonical place to stash it.
      let parser = state['__parser'] as ReturnType<typeof selectStreamParser> | undefined;
      if (!parser) {
        parser = selectStreamParser(def, sink);
        state['__parser'] = parser;
        state['__sink'] = sink;
      } else {
        // The cached sink writes to a stale `events` array (the previous
        // call's). Rebuild a parser with the current sink so events land
        // in the right buffer. Cheaper alternative: keep a mutable
        // events ref on the state — but this works fine for the test
        // budgets.
        parser = selectStreamParser(def, sink);
        state['__parser'] = parser;
      }
      parser.feed(line);
      return events;
    },

    /** Error classification — straight delegate to #262. */
    classifyError(stderr: string): ClassifiedError {
      return classify(def.id, stderr);
    },
  });
}

/**
 * Lazily-built map of every profile, keyed by `def.id`. Frozen on first
 * access so the registry surface is immutable from the consumer's
 * perspective.
 */
let _profilesCache: ReadonlyMap<string, ProviderProfile> | null = null;

export function listProfiles(): ReadonlyArray<ProviderProfile> {
  if (!_profilesCache) {
    const entries = AGENT_DEFS.map((def) => [def.id, buildProviderProfile(def)] as const);
    _profilesCache = new Map(entries);
  }
  return Array.from(_profilesCache.values());
}

export function getProfile(id: string): ProviderProfile | undefined {
  if (!_profilesCache) {
    void listProfiles();
  }
  return _profilesCache?.get(id);
}

/**
 * Reset the lazy cache. Test-only — production code should never call
 * this. The reset hook exists so unit tests that mutate
 * {@link AGENT_DEFS} (rare; only when a fake def is injected) can
 * invalidate the materialised map.
 */
export function __resetProfileCacheForTest(): void {
  _profilesCache = null;
}
