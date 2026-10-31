import { describe, expect, it, vi } from 'vitest';
import { RunModeStore } from './run-mode-store';

describe('RunModeStore', () => {
  it('defaults to plan and tracks each project independently', () => {
    const s = new RunModeStore();
    expect(s.get('/a')).toBe('plan');
    s.set('/a', 'apply', 'desktop');
    expect(s.get('/a')).toBe('apply');
    expect(s.get('/b')).toBe('plan');
  });

  it('notifies on change with the source, and not on a no-op', () => {
    const s = new RunModeStore();
    const fn = vi.fn();
    s.subscribe(fn);
    s.set('/a', 'apply-yolo', 'remote');
    s.set('/a', 'apply-yolo', 'remote');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('/a', 'apply-yolo', 'remote');
  });

  it('reset returns to plan and notifies with source "reset"', () => {
    const s = new RunModeStore();
    s.set('/a', 'apply', 'desktop');
    const fn = vi.fn();
    s.subscribe(fn);
    s.reset('/a');
    expect(s.get('/a')).toBe('plan');
    expect(fn).toHaveBeenCalledWith('/a', 'plan', 'reset');
  });

  it('a throwing listener does not break the change', () => {
    const s = new RunModeStore();
    s.subscribe(() => { throw new Error('boom'); });
    expect(() => s.set('/a', 'apply', 'desktop')).not.toThrow();
    expect(s.get('/a')).toBe('apply');
  });
});
