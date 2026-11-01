import { describe, expect, it } from 'vitest';

import { PLAN_PROTOCOL, buildPlanProtocolHint } from './plan-protocol';

describe('plan protocol', () => {
  it('is only offered in plan mode', () => {
    expect(buildPlanProtocolHint(true)).toBe(PLAN_PROTOCOL);
    expect(buildPlanProtocolHint(false)).toBeNull();
  });

  it('makes persisting the plan on the kanban mandatory, not optional', () => {
    expect(PLAN_PROTOCOL).toContain('kanban_create_spec');
    expect(PLAN_PROTOCOL).toContain('kanban_create_task');
    expect(PLAN_PROTOCOL).toContain('"todo"');
    expect(PLAN_PROTOCOL).toContain('dependsOn');
    expect(PLAN_PROTOCOL).toContain('acceptance criteria');
    // The old wording left it to the agent's judgement ("when large enough"),
    // which is why plans ended up in the chat only.
    expect(PLAN_PROTOCOL).not.toContain('large enough');
  });

  it('explores first, asks for approval and never implements', () => {
    expect(PLAN_PROTOCOL).toContain('Explore first');
    expect(PLAN_PROTOCOL).toContain('Ask for approval');
    expect(PLAN_PROTOCOL).toContain('Never start implementing');
  });

  it('tells the agent to update the board, not duplicate the spec, when the user keeps planning', () => {
    expect(PLAN_PROTOCOL).toContain('do not create a duplicate spec');
  });

  it('carries the kanban tool contract so the agent knows the signatures', () => {
    expect(PLAN_PROTOCOL).toContain('kanban_create_task(specId, title, body, dependsOn?, column?)');
  });
});
