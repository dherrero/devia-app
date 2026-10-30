/**
 * REV-AGENT-CORE-014 — Unit tests for the tool-icon registry.
 *
 * Verifies the canonical map covers every tool name required by FR1, that
 * lookups return `null` for unknown names (FR2 fallback), and that the
 * registry is frozen at module scope so callers cannot mutate it at runtime.
 */
import { describe, it, expect } from 'vitest';
import { TOOL_ICONS, getToolIcon } from '../../../shared/domain/tool-icons';

describe('TOOL_ICONS registry', () => {
  const REQUIRED_TOOLS = [
    'Bash',
    'Edit',
    'Write',
    'MultiEdit',
    'Read',
    'Grep',
    'Glob',
    'AskUserQuestion',
    'WebSearch',
    'WebFetch',
    'Task',
  ];

  for (const name of REQUIRED_TOOLS) {
    it(`covers ${name}`, () => {
      const entry = TOOL_ICONS[name];
      expect(entry).toBeDefined();
      expect(typeof entry?.iconName).toBe('string');
      expect(entry?.iconName.length ?? 0).toBeGreaterThan(0);
    });
  }

  it('maps Bash → terminal and AskUserQuestion → help (skim-quality spot checks)', () => {
    expect(TOOL_ICONS['Bash']?.iconName).toBe('terminal');
    expect(TOOL_ICONS['AskUserQuestion']?.iconName).toBe('help');
  });

  it('is frozen at module scope (no in-place mutation)', () => {
    expect(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (TOOL_ICONS as any)['NewTool'] = { iconName: 'star' };
    }).toThrow();
  });
});

describe('getToolIcon()', () => {
  it('returns the entry for a known tool', () => {
    const entry = getToolIcon('Edit');
    expect(entry).not.toBeNull();
    expect(entry?.iconName).toBe('edit');
  });

  it('returns null for an unknown tool (FR2 fallback)', () => {
    expect(getToolIcon('SomeRandomToolThatDoesNotExist')).toBeNull();
  });

  it('returns null for the empty string', () => {
    expect(getToolIcon('')).toBeNull();
  });

  it('is case-sensitive (matches the agent-emitted name verbatim)', () => {
    expect(getToolIcon('bash')).toBeNull();
    expect(getToolIcon('BASH')).toBeNull();
    expect(getToolIcon('Bash')).not.toBeNull();
  });
});
