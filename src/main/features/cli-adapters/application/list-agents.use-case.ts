import type { AgentDetector } from '../domain/ports';
import type { DetectedAgent } from '../domain/runtime-agent-def';

/**
 * Returns the full agent catalog with per-CLI detection results. The
 * renderer Settings tab calls this every time it opens so install /
 * upgrade outside Devia is reflected without restarting the app.
 */
export class ListAgentsUseCase {
  constructor(private readonly detector: AgentDetector) {}

  execute(): Promise<DetectedAgent[]> {
    return this.detector.detectAll();
  }
}
