import { describe, expect, it } from 'vitest';
import { reconcileMode } from './auto-mode';

describe('reconcileMode', () => {
  it('switches to plan from apply and apply-yolo on a plan verb', () => {
    expect(reconcileMode('apply', 'planifica esto')).toBe('plan');
    expect(reconcileMode('apply-yolo', 'analiza el bug')).toBe('plan');
  });

  it('leaves plan untouched on a plan verb', () => {
    expect(reconcileMode('plan', 'plan the refactor')).toBeNull();
  });

  it('switches plan → apply on an execute verb', () => {
    expect(reconcileMode('plan', 'ejecuta el plan')).toBe('apply');
  });

  it('never downgrades apply/apply-yolo on an execute verb', () => {
    expect(reconcileMode('apply', 'ejecuta')).toBeNull();
    expect(reconcileMode('apply-yolo', 'run it')).toBeNull();
  });

  it('ignores messages with no intent or with a keyword mid-sentence', () => {
    expect(reconcileMode('plan', 'arregla el bug')).toBeNull();
    expect(reconcileMode('apply', 'por favor analiza esto')).toBeNull();
  });
});
