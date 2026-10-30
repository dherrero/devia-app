import type { RunId } from '../../../../shared/domain/agent';
import { buildDefaultCapabilities, type RunMode } from '../../../../shared/domain/run-capabilities';
import type { AgentRunPlan } from '../domain';

/** Test helper: a complete, agent-agnostic run plan with overridable fields. */
export function makeRunPlan(overrides: Partial<AgentRunPlan> & { mode?: RunMode } = {}): AgentRunPlan {
  const mode = overrides.mode ?? 'apply';
  return {
    runId: 'run-1',
    agentId: 'fake-agent',
    mode,
    cwd: '/tmp/project',
    projectCheckout: '/tmp/project',
    deviaDir: '/tmp/.devia-app',
    prompt: 'hello',
    imagePaths: [],
    extraAllowedDirs: [],
    model: null,
    reasoning: null,
    envOverrides: {},
    capabilities: buildDefaultCapabilities('run-1' as RunId, mode),
    isRemote: false,
    harness: { mcp: { devia: [], user: [] }, skills: [], subagents: [], isolateExternalMcp: false },
    ui: { rendezvousDir: '/tmp/devia-ui/run-1', toolTimeoutMs: 300_000 },
    ...overrides,
  };
}
