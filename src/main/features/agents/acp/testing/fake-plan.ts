import type { RunId } from '../../../../../shared/domain/agent';
import type { McpServerConfig } from '../../../../../shared/domain/mcp';
import type { RunMode } from '../../../../../shared/domain/run-capabilities';
import type { AgentRunPlan } from '../../domain/agent-run-plan';

export function makePlan(overrides: Partial<AgentRunPlan> = {}): AgentRunPlan {
  const mode: RunMode = overrides.mode ?? 'apply';
  return {
    runId: 'run-1' as RunId,
    agentId: 'kimi',
    mode,
    cwd: '/work/project',
    projectCheckout: '/work/project',
    deviaDir: '/tmp/devia',
    prompt: 'hello',
    imagePaths: [],
    extraAllowedDirs: [],
    envOverrides: {},
    capabilities: { runId: 'run-1' as RunId, mode, expiresAt: 0 },
    isRemote: false,
    harness: { mcp: { devia: [], user: [] }, skills: [], subagents: [], isolateExternalMcp: false },
    ui: { rendezvousDir: '/tmp/devia/ui', toolTimeoutMs: 300_000 },
    ...overrides,
  };
}

export function mcpServer(id: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return { id, name: id, command: 'node', args: [], enabled: true, ...overrides };
}
