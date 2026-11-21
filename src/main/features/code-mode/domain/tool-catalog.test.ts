import { describe, expect, it } from 'vitest';

import { classifyTool } from './tool-catalog';

describe('classifyTool', () => {
  it('is read only when the server says readOnlyHint === true', () => {
    expect(classifyTool({ readOnlyHint: true })).toBe('read');
  });

  it('treats a tool without annotations as a write', () => {
    expect(classifyTool(undefined)).toBe('write');
    expect(classifyTool({})).toBe('write');
  });

  it('treats readOnlyHint false as a write', () => {
    expect(classifyTool({ readOnlyHint: false })).toBe('write');
  });

  it('lets the user override either way', () => {
    expect(classifyTool(undefined, 'read')).toBe('read');
    expect(classifyTool({ readOnlyHint: true }, 'write')).toBe('write');
  });
});
