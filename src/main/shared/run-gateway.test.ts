import { describe, it, expect, vi } from 'vitest';
import { RunGateway, type RunGatewayEvent } from './run-gateway';
import type { RunId } from '../../shared/domain/agent';
import type { WorkerRun } from '../../shared/domain/cross-agent';

describe('RunGateway — tool answers and new events (S-56 T12)', () => {
  it('routes an answer to a blocked tool call through the bound handler', () => {
    const gateway = new RunGateway();
    const handler = vi.fn();
    gateway.bindToolResult(handler);
    expect(gateway.answerTool('proj-a', 'call-1', '1. b')).toBe(true);
    expect(handler).toHaveBeenCalledWith('proj-a', 'call-1', '1. b');
  });

  it('reports false instead of throwing when nothing is bound', () => {
    expect(new RunGateway().answerTool('proj-a', 'call-1', 'x')).toBe(false);
  });

  it('delivers ask and worker events to subscribers like any other event', () => {
    const gateway = new RunGateway();
    const seen: RunGatewayEvent[] = [];
    gateway.subscribe((e) => seen.push(e));
    const worker: WorkerRun = {
      id: 'W-1', parentKey: 'proj-a', turnId: 't', taskId: 'T-1', role: 'implementer', agentId: 'pi', runKey: 'k', state: 'running',
    };
    gateway.publish({
      type: 'ask',
      project: 'proj-a',
      runId: 'r1' as RunId,
      callId: 'call-1',
      mainAgentId: 'claude',
      question: { roles: ['implementer'], options: [{ key: 'a', agentId: 'main' }] },
    });
    gateway.publish({ type: 'worker', project: 'proj-a', worker });
    expect(seen.map((e) => e.type)).toEqual(['ask', 'worker']);
  });
});
