import type { AgentDetector } from '../domain/ports';
import type { DetectedAgent } from '../domain/runtime-agent-def';

/**
 * Re-runs the full detection pipeline (version probe + auth probe) for a
 * single agent. Returns the same `DetectedAgent` shape used by `agents:list`
 * so the renderer can display `authStatus`, `diagnostic`, and `resolvedBin`
 * after an on-demand "Probar" button click. (REV-TS-CLI-13-03)
 *
 * The IPC layer maps `DetectedAgent` → `DetectedAgentView` via `toView()`
 * before sending it to the renderer — no data is lost.
 */
export class TestAgentUseCase {
  constructor(private readonly detector: AgentDetector) {}

  async execute(agentId: string): Promise<DetectedAgent | { available: false; id?: never; message: string }> {
    const detected = await this.detector.detectOne(agentId);
    if (!detected) {
      return { available: false, message: 'Adapter desconocido' };
    }
    return detected;
  }
}
