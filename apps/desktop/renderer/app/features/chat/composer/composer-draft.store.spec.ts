import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ComposerDraftStore, type ComposerDraftSnapshot } from './composer-draft.store';
import type { PendingAttachment } from '../chat-panel/models/pending-attachment.model';

function makeAttachment(id: string): PendingAttachment {
  return {
    id,
    name: `${id}.png`,
    mime: 'image/png',
    blob: new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    previewUrl: `blob://fake/${id}`,
    kind: 'image',
    size: 3,
  };
}

function snap(draft: string, attachments: PendingAttachment[] = []): ComposerDraftSnapshot {
  return { draft, attachments };
}

describe('ComposerDraftStore (S-14)', () => {
  let store: ComposerDraftStore;
  let revokeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    store = new ComposerDraftStore();
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    revokeSpy.mockRestore();
  });

  it('returns null for an unknown key', () => {
    expect(store.snapshot('/ws/a')).toBeNull();
  });

  it('save() + snapshot() round-trips a draft', () => {
    store.save('/ws/a', snap('hola mundo'));
    expect(store.snapshot('/ws/a')).toEqual({ draft: 'hola mundo', attachments: [] });
  });

  it('save() overwrites the previous snapshot for the same key', () => {
    store.save('/ws/a', snap('first'));
    store.save('/ws/a', snap('second'));
    expect(store.snapshot('/ws/a')?.draft).toBe('second');
  });

  it('keys are isolated: each pane keeps its own draft', () => {
    store.save('/ws/base-project', snap('primary pane draft'));
    store.save('session-uuid-1', snap('split pane draft'));
    expect(store.snapshot('/ws/base-project')?.draft).toBe('primary pane draft');
    expect(store.snapshot('session-uuid-1')?.draft).toBe('split pane draft');
  });

  it('save() with an empty key is a no-op', () => {
    store.save('', snap('lost'));
    expect(store.snapshot('')).toBeNull();
  });

  it('save() of an empty snapshot deletes the entry (no blank drafts)', () => {
    store.save('/ws/a', snap('typed'));
    store.save('/ws/a', snap(''));
    expect(store.snapshot('/ws/a')).toBeNull();
  });

  it('save() of an empty draft WITH attachments keeps the entry', () => {
    store.save('/ws/a', snap('', [makeAttachment('one')]));
    expect(store.snapshot('/ws/a')?.attachments.length).toBe(1);
  });

  it('clear() drops the entry without revoking preview URLs', () => {
    store.save('/ws/a', snap('text', [makeAttachment('one')]));
    store.clear('/ws/a');
    expect(store.snapshot('/ws/a')).toBeNull();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('purge() drops the entry and revokes every preview URL', () => {
    store.save('s-1', snap('text', [makeAttachment('one'), makeAttachment('two')]));
    store.purge('s-1');
    expect(store.snapshot('s-1')).toBeNull();
    expect(revokeSpy).toHaveBeenCalledTimes(2);
    expect(revokeSpy).toHaveBeenCalledWith('blob://fake/one');
    expect(revokeSpy).toHaveBeenCalledWith('blob://fake/two');
  });

  it('purge() of an unknown key is a no-op', () => {
    store.purge('missing');
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('purge() only touches the purged key', () => {
    store.save('s-1', snap('a', [makeAttachment('one')]));
    store.save('s-2', snap('b', [makeAttachment('two')]));
    store.purge('s-1');
    expect(store.snapshot('s-2')?.draft).toBe('b');
    expect(revokeSpy).toHaveBeenCalledTimes(1);
  });

  // ── T-162: tombstone — a late destroy-save cannot resurrect a purged key ──

  it('save() after purge() is ignored (the closed pane destroy-save races the purge)', () => {
    store.save('s-1', snap('typed'));
    store.purge('s-1');
    store.save('s-1', snap('late destroy-save'));
    expect(store.snapshot('s-1')).toBeNull();
  });

  it('snapshot() reopens a purged key — a remounted composer saves normally again', () => {
    store.purge('s-1');
    expect(store.snapshot('s-1')).toBeNull(); // the remount read reopens
    store.save('s-1', snap('fresh draft'));
    expect(store.snapshot('s-1')?.draft).toBe('fresh draft');
  });

  it('clear() does NOT tombstone — the send path keeps saving afterwards', () => {
    store.save('s-1', snap('msg'));
    store.clear('s-1');
    store.save('s-1', snap('', [makeAttachment('kept')]));
    expect(store.snapshot('s-1')?.attachments.length).toBe(1);
  });
});
