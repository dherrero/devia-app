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
