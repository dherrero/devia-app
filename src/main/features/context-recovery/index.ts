import { MemoryReinjectionTracker } from './application/memory-reinjection-tracker';

/**
 * Context-recovery feature (E-DSK-13 Fase D).
 *
 * When a CLI agent compacts its own context mid-session, the older turns —
 * including any memory Devia injected earlier — are summarised away. This
 * feature lets the runner re-inject Devia's memory on the next run so the
 * agent recovers what it knew.
 *
 * Detection (which raw stream event means "I just compacted") lives in the
 * per-agent stream parsers in `cli-adapters`, because that is where the
 * raw-JSON knowledge already lives. Each parser emits the shared
 * `{ type: 'context_compacted' }` AgentEvent; this feature only owns the
 * cross-run *policy* (mark on compaction → re-inject once on the next run).
 *
 * Per-agent wiring status:
 *   - claude      WIRED. Claude Code stream-json emits a system event with
 *                 `subtype: "compact_boundary"` (auto/manual) — mapped in
 *                 `parsers/claude-stream.ts`.
 *   - codex       PENDING. Auto-compacts internally; no distinct compaction
 *                 event observed in its experimental JSON stream (only token
 *                 counts on `turn.completed`). See docs/memory/03-*.md.
 *   - gemini      PENDING. Has internal chat compression; its JSON event for
 *                 it is unverified.
 *   - opencode /
 *     cursor-agent /
 *     copilot     PENDING. No verified in-stream compaction signal.
 *
 * For the PENDING agents a token-threshold fallback (re-inject proactively
 * before the CLI compacts, using the `usage` token counts Devia already
 * receives) is documented as the next step in docs/memory/03-*.md.
 */
export function buildContextRecoveryFeature(): {
  tracker: MemoryReinjectionTracker;
  markContextCompacted: (projectPath: string) => void;
  consumeMemoryReinjection: (projectPath: string) => boolean;
} {
  const tracker = new MemoryReinjectionTracker();
  return {
    tracker,
    markContextCompacted: (projectPath) => tracker.markCompacted(projectPath),
    consumeMemoryReinjection: (projectPath) => tracker.consume(projectPath),
  };
}

export { MemoryReinjectionTracker } from './application/memory-reinjection-tracker';
