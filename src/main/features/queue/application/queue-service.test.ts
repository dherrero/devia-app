import { describe, it, expect, vi } from 'vitest';
import { QueueService } from './queue-service';
import type { InstructionDispatcher, QueueRepository, QueueRepositorySnapshot } from '../domain/ports';
import type { ProjectRegistry } from '../../../shared/ports';

class FakeRepo implements QueueRepository {
  load(): Map<string, QueueRepositorySnapshot> { return new Map(); }
  save(): void { /* no-op */ }
  flush(): void { /* no-op */ }
}

/** Only `isRunning` is exercised by the queue; the rest is never called. */
function fakeRegistry(running = false): ProjectRegistry {
  return { isRunning: () => running } as unknown as ProjectRegistry;
}

function makeService(running = false): QueueService {
  return new QueueService({ repo: new FakeRepo(), registry: fakeRegistry(running) });
}

describe('QueueService — origin round-trip', () => {
  it('dispatches a queued remote item carrying its remote origin on the item', () => {
    const svc = makeService();
    const dispatch = vi.fn(() => true);
    svc.attachDispatcher({ dispatch });

    // Enqueue while "busy" semantics don't matter here — add() is direct.
    svc.add('proj', 'do it', { origin: 'remote' });
    svc.dispatchNext('proj');

    expect(dispatch).toHaveBeenCalledWith('proj', 'do it', expect.objectContaining({ origin: 'remote' }));
  });

  it('dispatches a renderer item with no origin field when none is given', () => {
    const svc = makeService();
    const dispatch = vi.fn<InstructionDispatcher['dispatch']>(() => true);
    svc.attachDispatcher({ dispatch });

    svc.add('proj', 'do it');
    svc.dispatchNext('proj');

    const item = dispatch.mock.calls[0]?.[2];
    expect(item?.origin).toBeUndefined();
  });

  it('persists remote origin on the item but omits the default renderer origin', () => {
    const svc = makeService();
    const remote = svc.add('proj', 'remote one', { origin: 'remote' });
    const local = svc.add('proj', 'local one');

    expect(remote.origin).toBe('remote');
    expect(local.origin).toBeUndefined();
  });
});

// ── S-13 T-143 — per-session queue keyed by identity ─────────────────────────

describe('QueueService — split-view run context (T-143)', () => {
  function registryRunning(runningKeys: Set<string>): ProjectRegistry {
    return { isRunning: (k: string) => runningKeys.has(k) } as unknown as ProjectRegistry;
  }

  it('shouldEnqueue is keyed per identity: a busy base does not park another session', () => {
    const svc = new QueueService({
      repo: new FakeRepo(),
      registry: registryRunning(new Set(['/ws/proj'])),
    });
    // Primary identity busy → enqueue; additional session identity free → run inline.
    expect(svc.shouldEnqueue('/ws/proj')).toBe(true);
    expect(svc.shouldEnqueue('/ws/proj::s2')).toBe(false);
  });

  it('add() stores the run context and the dispatcher receives it', () => {
    const svc = makeService();
    const dispatch = vi.fn(() => true);
    svc.attachDispatcher({ dispatch });

    svc.add('/ws/proj::s2', 'do it', {
      mode: 'apply',
      baseProject: '/ws/proj',
      runKey: '/ws/proj::s2',
      isolate: true,
      sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
    });
    svc.dispatchNext('/ws/proj::s2');

    expect(dispatch).toHaveBeenCalledWith(
      '/ws/proj::s2',
      'do it',
      expect.objectContaining({
        baseProject: '/ws/proj',
        runKey: '/ws/proj::s2',
        isolate: true,
        sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef0123456789',
      }),
    );
  });

  it('two identities keep independent queues', () => {
    const svc = makeService();
    svc.add('/ws/proj', 'a');
    svc.add('/ws/proj::s2', 'b');
    expect(svc.view('/ws/proj').items.map((i) => i.text)).toEqual(['a']);
    expect(svc.view('/ws/proj::s2').items.map((i) => i.text)).toEqual(['b']);
  });
});

// ── S-2 F3.4 — agent override round-trip ────────────────────────────────────

describe('QueueService — agentIdOverride round-trip (S-2 F3.4)', () => {
  it('a queued handoff-summary request keeps its agent override through dispatch', () => {
    const svc = makeService();
    const dispatch = vi.fn(() => true);
    svc.attachDispatcher({ dispatch });

    const item = svc.add('proj', 'genera resumen de traspaso', { agentIdOverride: 'codex' });
    expect(item.agentIdOverride).toBe('codex');

    svc.dispatchNext('proj');
    expect(dispatch).toHaveBeenCalledWith(
      'proj',
      'genera resumen de traspaso',
      expect.objectContaining({ agentIdOverride: 'codex' }),
    );
  });

  it('regular items carry no override field', () => {
    const svc = makeService();
    const item = svc.add('proj', 'normal');
    expect('agentIdOverride' in item).toBe(false);
  });
});
