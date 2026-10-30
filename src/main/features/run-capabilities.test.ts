/**
 * Tests for REV-AGENT-CORE-005 `RunCapabilities` helpers.
 */

import { describe, it, expect } from 'vitest';
import {
  buildDefaultCapabilities,
  resolveDisallowedTools,
  sanitiseToolName,
  sanitiseToolNames,
} from '../../shared/domain/run-capabilities';
import type { RunId } from '../../shared/domain/agent';

const RID = 'test-run-id' as RunId;

describe('buildDefaultCapabilities', () => {
  it('mints a minimal apply-mode descriptor with no denylist when no defaults supplied', () => {
    const cap = buildDefaultCapabilities(RID, 'apply');
    expect(cap.runId).toBe(RID);
    expect(cap.mode).toBe('apply');
    expect(cap.disallowedTools).toBeUndefined();
    expect(cap.expiresAt).toBeGreaterThan(Date.now());
  });

  it('includes adapter defaults in apply mode', () => {
    const cap = buildDefaultCapabilities(RID, 'apply', {
      defaultDisallowedTools: ['WebSearch', 'WebFetch'],
    });
    expect(cap.disallowedTools).toEqual(['WebSearch', 'WebFetch']);
  });

  it('plan mode adds file-mutation tools to the denylist on top of adapter defaults', () => {
    const cap = buildDefaultCapabilities(RID, 'plan', {
      defaultDisallowedTools: ['WebSearch'],
    });
    expect(cap.disallowedTools).toEqual(
      expect.arrayContaining(['WebSearch', 'Edit', 'Write', 'MultiEdit', 'Bash']),
    );
  });

  it('apply-yolo mode does not add plan-mode restrictions', () => {
    const cap = buildDefaultCapabilities(RID, 'apply-yolo', {
      defaultDisallowedTools: ['WebSearch'],
    });
    expect(cap.disallowedTools).toEqual(['WebSearch']);
  });

  it('dedupes the denylist when adapter defaults overlap with plan-mode adds', () => {
    const cap = buildDefaultCapabilities(RID, 'plan', {
      defaultDisallowedTools: ['Edit', 'Custom'],
    });
    // 'Edit' must appear once even though it's in both the default and plan-mode lists.
    const editCount = cap.disallowedTools?.filter(t => t === 'Edit').length ?? 0;
    expect(editCount).toBe(1);
    expect(cap.disallowedTools).toEqual(
      expect.arrayContaining(['Edit', 'Custom', 'Write', 'MultiEdit', 'Bash']),
    );
  });

  it('honours custom ttlMs', () => {
    const before = Date.now();
    const cap = buildDefaultCapabilities(RID, 'apply', { ttlMs: 1_000 });
    expect(cap.expiresAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(cap.expiresAt).toBeLessThanOrEqual(before + 2_000);
  });
});

describe('resolveDisallowedTools', () => {
  it('returns an empty array when disallowedTools is undefined', () => {
    const cap = buildDefaultCapabilities(RID, 'apply');
    expect(resolveDisallowedTools(cap)).toEqual([]);
  });

  it('returns the denylist verbatim', () => {
    const cap = {
      runId: RID,
      mode: 'apply' as const,
      disallowedTools: ['Edit', 'Write'],
      expiresAt: Date.now() + 1000,
    };
    expect(resolveDisallowedTools(cap)).toEqual(['Edit', 'Write']);
  });

  it('dedupes the denylist', () => {
    const cap = {
      runId: RID,
      mode: 'apply' as const,
      disallowedTools: ['Edit', 'Edit', 'Write', 'Write'],
      expiresAt: Date.now() + 1000,
    };
    expect(resolveDisallowedTools(cap)).toEqual(['Edit', 'Write']);
  });
});

describe('sanitiseToolName (REV-AGENT-CORE-007)', () => {
  it('accepts simple alphanumeric tool names', () => {
    expect(sanitiseToolName('Bash')).toBe('Bash');
    expect(sanitiseToolName('Edit')).toBe('Edit');
    expect(sanitiseToolName('Tool_With_Underscore')).toBe('Tool_With_Underscore');
    expect(sanitiseToolName('tool-with-dash')).toBe('tool-with-dash');
  });

  it('trims surrounding whitespace', () => {
    expect(sanitiseToolName('  Bash  ')).toBe('Bash');
  });

  it('rejects non-strings, empty, oversized, or invalid-char inputs', () => {
    expect(sanitiseToolName(null)).toBeNull();
    expect(sanitiseToolName(undefined)).toBeNull();
    expect(sanitiseToolName(42)).toBeNull();
    expect(sanitiseToolName('')).toBeNull();
    expect(sanitiseToolName('   ')).toBeNull();
    expect(sanitiseToolName('a'.repeat(65))).toBeNull();
    expect(sanitiseToolName('rm -rf /')).toBeNull();
    expect(sanitiseToolName('tool$injection')).toBeNull();
    expect(sanitiseToolName('with space')).toBeNull();
  });

  it('accepts the boundary 64-char length', () => {
    expect(sanitiseToolName('a'.repeat(64))).toBe('a'.repeat(64));
  });
});

describe('sanitiseToolNames (REV-AGENT-CORE-007)', () => {
  it('returns the valid entries in order', () => {
    expect(sanitiseToolNames(['Bash', 'Edit', 'Write'])).toEqual(['Bash', 'Edit', 'Write']);
  });

  it('silently drops invalid entries', () => {
    expect(sanitiseToolNames(['Bash', '', 'rm -rf', null, 'Edit'])).toEqual(['Bash', 'Edit']);
  });

  it('dedupes', () => {
    expect(sanitiseToolNames(['Bash', 'Bash', 'Edit'])).toEqual(['Bash', 'Edit']);
  });

  it('returns empty array for non-array input', () => {
    expect(sanitiseToolNames(null)).toEqual([]);
    expect(sanitiseToolNames(undefined)).toEqual([]);
    expect(sanitiseToolNames('Bash')).toEqual([]);
    expect(sanitiseToolNames({ tool: 'Bash' })).toEqual([]);
  });
});
