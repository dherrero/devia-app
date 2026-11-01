import { describe, expect, it } from 'vitest';
import { seedRunModes } from './seed-run-modes';
import { RunModeStore } from './run-mode-store';
import type { ProjectRegistry, SessionStore } from './ports';

function fakes(rows: Record<string, { active?: string; mode?: string; boom?: boolean }>) {
  const registry = {
    entries: () => Object.entries(rows).map(([k, v]) => [k, { activeSessionId: v.active }])[Symbol.iterator](),
  } as unknown as ProjectRegistry;
  const sessions = {
    load: (project: string) => {
      const row = rows[project]!;
      if (row.boom) throw new Error('corrupt');
      return { runMode: row.mode };
    },
  } as unknown as SessionStore;
  return { registry, sessions };
}

describe('seedRunModes', () => {
  it('restores the stored mode of each active session and skips the rest', () => {
    const { registry, sessions } = fakes({
      '/a': { active: 's1', mode: 'apply' },
      '/b': { active: 's2' },
      '/c': { mode: 'apply-yolo' },
      '/d': { active: 's4', boom: true },
    });
    const store = new RunModeStore();
    const seen: string[] = [];
    store.subscribe((_p, _m, source) => seen.push(source));
    seedRunModes(registry, sessions, store);
    expect(store.get('/a')).toBe('apply');
    expect(store.get('/b')).toBe('plan');
    expect(store.get('/c')).toBe('plan');
    expect(store.get('/d')).toBe('plan');
    expect(seen).toEqual(['restore']);
  });
});
