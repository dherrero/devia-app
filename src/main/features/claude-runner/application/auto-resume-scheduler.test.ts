import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AutoResumeScheduler, type AutoResumeCancelReason } from './auto-resume-scheduler';

const MIN = 60_000;

describe('AutoResumeScheduler', () => {
  let clock: number;
  let due: string[];
  let scheduled: Array<[string, number]>;
  let cancelled: Array<[string, AutoResumeCancelReason]>;
  let scheduler: AutoResumeScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = 1_000_000_000;
    due = [];
    scheduled = [];
    cancelled = [];
    scheduler = new AutoResumeScheduler({
      now: () => clock,
      onDue: (k) => due.push(k),
      onScheduled: (k, at) => scheduled.push([k, at]),
      onCancelled: (k, r) => cancelled.push([k, r]),
      marginMs: 30_000,
      pollMs: 10_000,
    });
  });

  afterEach(() => {
    scheduler.dispose();
    vi.useRealTimers();
  });

  const advance = (ms: number) => {
    clock += ms;
    vi.advanceTimersByTime(ms);
  };

  it('fires once the reset plus the margin has passed, and not before', () => {
    expect(scheduler.schedule('p', clock + 10 * MIN)).toBe(true);
    expect(scheduled).toEqual([['p', clock + 10 * MIN + 30_000]]);
    advance(10 * MIN);
    expect(due).toEqual([]);
    advance(30_000);
    expect(due).toEqual(['p']);
    expect(scheduler.isPending('p')).toBe(false);
  });

  it('fires on tick() after the clock jumped past the deadline (machine slept)', () => {
    scheduler.schedule('p', clock + 10 * MIN);
    clock += 3 * 60 * MIN;
    scheduler.tick();
    expect(due).toEqual(['p']);
  });

  it('schedules the weekly window too (days away)', () => {
    expect(scheduler.schedule('p', clock + 5 * 24 * 60 * MIN)).toBe(true);
    clock += 5 * 24 * 60 * MIN + 31_000;
    scheduler.tick();
    expect(due).toEqual(['p']);
  });

  it('does not schedule a wait beyond the sanity cap', () => {
    expect(scheduler.schedule('p', clock + 30 * 24 * 60 * MIN)).toBe(false);
    expect(scheduled).toEqual([]);
  });

  it('cancel stops the resume and reports why', () => {
    scheduler.schedule('p', clock + MIN);
    scheduler.cancel('p', 'user');
    advance(10 * MIN);
    expect(due).toEqual([]);
    expect(cancelled).toEqual([['p', 'user']]);
  });

  it('rescheduling replaces the pending job', () => {
    scheduler.schedule('p', clock + MIN);
    scheduler.schedule('p', clock + 5 * MIN);
    expect(cancelled).toEqual([['p', 'replaced']]);
    advance(2 * MIN);
    expect(due).toEqual([]);
    advance(4 * MIN);
    expect(due).toEqual(['p']);
  });

  it('gives up after three resumes in a row that hit the limit again', () => {
    for (let i = 0; i < 3; i += 1) {
      expect(scheduler.schedule('p', clock + MIN)).toBe(true);
      advance(2 * MIN);
    }
    expect(due).toHaveLength(3);
    expect(scheduler.schedule('p', clock + MIN)).toBe(false);
  });

  it('a clean run starts a fresh streak', () => {
    for (let i = 0; i < 3; i += 1) {
      scheduler.schedule('p', clock + MIN);
      advance(2 * MIN);
    }
    scheduler.noteCleanRun('p');
    expect(scheduler.schedule('p', clock + MIN)).toBe(true);
  });

  it('keeps sessions independent', () => {
    scheduler.schedule('a', clock + MIN);
    scheduler.schedule('b', clock + 5 * MIN);
    advance(2 * MIN);
    expect(due).toEqual(['a']);
    expect(scheduler.isPending('b')).toBe(true);
  });
});
