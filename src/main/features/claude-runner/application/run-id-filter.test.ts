import { describe, it, expect } from 'vitest';
import { isForeignEvent } from '../../../../shared/domain/agent';
import type { RunId } from '../../../../shared/domain/agent';

const R1 = 'run-001' as RunId;
const R2 = 'run-002' as RunId;

describe('isForeignEvent', () => {
  it('AC1: stream has runId R1, event has same R1 → not foreign', () => {
    expect(isForeignEvent(R1, R1)).toBe(false);
  });

  it('AC1: stream has runId R1, event has different R2 → foreign', () => {
    expect(isForeignEvent(R1, R2)).toBe(true);
  });

  it('AC2: stream has runId R1, event has no runId → foreign', () => {
    expect(isForeignEvent(R1, undefined)).toBe(true);
  });

  it('AC3: stream has no runId (legacy), event has any runId → not foreign', () => {
    expect(isForeignEvent(undefined, R1)).toBe(false);
  });

  it('AC3: stream has no runId, event has no runId → not foreign', () => {
    expect(isForeignEvent(undefined, undefined)).toBe(false);
  });
});
