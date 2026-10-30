import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import {
  PendingAttachmentsService,
  type AttachmentPayload,
} from './pending-attachments.service';
import {
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
} from '../../../../../../shared/domain/attachment';

function makeSvc(): PendingAttachmentsService {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [PendingAttachmentsService] });
  return TestBed.inject(PendingAttachmentsService);
}

function imageBlob(mime = 'image/png'): Blob {
  return new Blob([new Uint8Array([1, 2, 3, 4])], { type: mime });
}

describe('PendingAttachmentsService (HT-CH-01)', () => {
  let createSpy: ReturnType<typeof vi.spyOn>;
  let revokeSpy: ReturnType<typeof vi.spyOn>;
  let counter: number;

  beforeEach(() => {
    counter = 0;
    createSpy = vi
      .spyOn(URL, 'createObjectURL')
      .mockImplementation(() => `blob://fake/${++counter}`);
    revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  });

  afterEach(() => {
    // `vi.spyOn` keeps wrapping the same property between runs, so the
    // call history bleeds across tests if we don't restore the originals.
    createSpy.mockRestore();
    revokeSpy.mockRestore();
  });

  it('starts empty', () => {
    const svc = makeSvc();
    expect(svc.items()).toEqual([]);
    expect(svc.hasAny).toBe(false);
  });

  it('add() pushes an image, mints a previewUrl and returns the id', () => {
    const svc = makeSvc();
    const id = svc.add(imageBlob(), 'a.png');
    expect(id).not.toBeNull();
    expect(svc.items().length).toBe(1);
    expect(svc.items()[0].name).toBe('a.png');
    expect(svc.items()[0].previewUrl).toBe('blob://fake/1');
    expect(createSpy).toHaveBeenCalledTimes(1);
  });

  it('add() accepts non-image blobs without minting a preview URL', () => {
    const svc = makeSvc();
    const id = svc.add(new Blob(['hello'], { type: 'text/plain' }), 'note.txt');
    expect(id).not.toBeNull();
    expect(svc.items()[0]).toMatchObject({ name: 'note.txt', previewUrl: null, kind: 'text', size: 5 });
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('add() accepts an untyped binary', () => {
    const svc = makeSvc();
    svc.add(new Blob([new Uint8Array([0, 1])]), 'model.onnx');
    expect(svc.items()[0]).toMatchObject({ mime: '', kind: 'binary', previewUrl: null });
  });

  it('add() refuses a file over the per-file cap', () => {
    const svc = makeSvc();
    const big = { size: MAX_ATTACHMENT_BYTES + 1, type: 'application/zip' } as Blob;
    expect(svc.add(big, 'big.zip')).toBeNull();
    expect(svc.items()).toEqual([]);
  });

  it('add() refuses a file that would push the send over the total cap', () => {
    const svc = makeSvc();
    const chunk = { size: MAX_ATTACHMENT_BYTES, type: '' } as Blob;
    let accepted = 0;
    while (svc.add(chunk, `p${accepted}.bin`)) accepted++;
    expect(accepted).toBe(Math.floor(MAX_ATTACHMENTS_TOTAL_BYTES / MAX_ATTACHMENT_BYTES));
  });

  it('remove()/clear() skip revoking items without a preview', () => {
    const svc = makeSvc();
    const id = svc.add(new Blob(['x']), 'a.bin') as string;
    svc.add(new Blob(['y']), 'b.bin');
    svc.remove(id);
    svc.clear();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('add() falls back to a synthesised name when the caller passes null', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), null);
    expect(svc.items()[0].name).toMatch(/^pasted-\d+\.png$/);
  });

  it('remove() revokes the URL and drops the item', () => {
    const svc = makeSvc();
    const id = svc.add(imageBlob(), 'one.png') as string;
    svc.add(imageBlob(), 'two.png');
    svc.remove(id);
    expect(svc.items().length).toBe(1);
    expect(svc.items()[0].name).toBe('two.png');
    expect(revokeSpy).toHaveBeenCalledWith('blob://fake/1');
  });

  it('remove() is a no-op for an unknown id', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), 'one.png');
    svc.remove('does-not-exist');
    expect(svc.items().length).toBe(1);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('drain() returns the snapshot, clears the list and keeps URLs alive', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), 'a.png');
    svc.add(imageBlob(), 'b.png');
    const snap = svc.drain();
    expect(snap.length).toBe(2);
    expect(svc.items()).toEqual([]);
    expect(revokeSpy).not.toHaveBeenCalled(); // caller disposes
  });

  it('disposePreviews() revokes every URL in the snapshot', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), 'a.png');
    svc.add(imageBlob(), 'b.png');
    const snap = svc.drain();
    svc.disposePreviews(snap);
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });

  it('clear() revokes every URL and empties the list', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), 'a.png');
    svc.add(imageBlob(), 'b.png');
    svc.clear();
    expect(svc.items()).toEqual([]);
    expect(revokeSpy).toHaveBeenCalledTimes(2);
  });

  it('toPayloads() materialises the IPC shape', async () => {
    const svc = makeSvc();
    svc.add(imageBlob('image/png'), 'one.png');
    svc.add(imageBlob('image/jpeg'), 'two.jpg');
    const snap = svc.items();
    const payloads: AttachmentPayload[] = await PendingAttachmentsService.toPayloads(snap);
    expect(payloads.map((p) => ({ name: p.name, mime: p.mime, size: p.buffer.byteLength }))).toEqual([
      { name: 'one.png', mime: 'image/png', size: 4 },
      { name: 'two.jpg', mime: 'image/jpeg', size: 4 },
    ]);
  });

  // ── restore() — S-14 draft persistence ────────────────────────────────

  it('restore() replaces the list without minting or revoking URLs', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), 'old.png');
    createSpy.mockClear();

    const snapshot = [
      {
        id: 'restored-1',
        name: 'restored.png',
        mime: 'image/png',
        blob: imageBlob(),
        previewUrl: 'blob://fake/preexisting',
        kind: 'image' as const,
        size: 4,
      },
    ];
    svc.restore(snapshot);

    expect(svc.items().length).toBe(1);
    expect(svc.items()[0].id).toBe('restored-1');
    expect(svc.items()[0].previewUrl).toBe('blob://fake/preexisting');
    expect(createSpy).not.toHaveBeenCalled();
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  it('restore([]) empties the list without revoking', () => {
    const svc = makeSvc();
    svc.add(imageBlob(), 'a.png');
    svc.restore([]);
    expect(svc.items()).toEqual([]);
    expect(revokeSpy).not.toHaveBeenCalled();
  });

  // ── Instance isolation (T-147) ────────────────────────────────────────
  // Two independent instances (one per chat panel in split-view) must
  // never share attachment state — adding to A must not affect B.
  it('two instances do not share state: adding to A leaves B empty', () => {
    const a = new PendingAttachmentsService();
    const b = new PendingAttachmentsService();
    a.add(imageBlob(), 'a.png');
    expect(a.items().length).toBe(1);
    expect(b.items().length).toBe(0);
  });

  it('two instances do not share state: clearing A leaves B untouched', () => {
    const a = new PendingAttachmentsService();
    const b = new PendingAttachmentsService();
    a.add(imageBlob(), 'a.png');
    b.add(imageBlob(), 'b.png');
    a.clear();
    expect(a.items().length).toBe(0);
    expect(b.items().length).toBe(1);
  });
});
