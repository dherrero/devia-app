import { describe, expect, it } from 'vitest';

import { UI_TOOL_REGISTRY } from './tool-registry';

describe('ask_user tool description', () => {
  const description = UI_TOOL_REGISTRY.ask_user.description;

  it('tells the agent to ALWAYS use the card for every question', () => {
    expect(description).toContain('ALWAYS');
  });

  it('no longer sends open-ended questions to plain text', () => {
    expect(description).not.toContain('plain text in your reply');
  });
});

describe('spawn_agent tool definition (S-56)', () => {
  const def = UI_TOOL_REGISTRY.spawn_agent;

  it('is blocking, with a role and a task id both required', () => {
    expect(def.kind).toBe('blocking');
    expect(def.publicName).toBe('devia_spawn_agent');
    const schema = def.inputSchema as { required?: string[]; properties?: Record<string, { enum?: string[] }> };
    expect(schema.required).toEqual(['role', 'taskId']);
    expect(schema.properties?.['role']?.enum).toEqual(['implementer', 'reviewer']);
  });

  it('tells the model the worker has no context and works in its own worktree', () => {
    expect(def.description).toMatch(/no context of this conversation/i);
    expect(def.description).toMatch(/own worktree/i);
    expect(def.description).toMatch(/STATUS/);
  });
});
