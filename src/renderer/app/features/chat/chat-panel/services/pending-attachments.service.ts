import { Injectable, signal } from '@angular/core';
import {
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
  attachmentKind,
} from '../../../../../../shared/domain/attachment';
import type { PendingAttachment } from '../models/pending-attachment.model';

export interface AttachmentPayload {
  readonly name: string;
  readonly mime: string;
  readonly buffer: ArrayBuffer;
}

/**
 * In-flight composer attachments (HT-CH-01).
 *
 * Tracks the files the user has dropped / pasted / picked but not yet
 * sent. Centralises the object-URL lifecycle: images get a preview URL via
 * `URL.createObjectURL`, and every removal (single, drain or full clear)
 * revokes it so we don't leak Blob memory. Any file type is accepted; the
 * size caps mirror the main process so an oversized file is refused here,
 * before its bytes are copied over IPC.
 */
// One instance per ChatPanelComponent (component-scoped via providers[]).
// Split-view panels (T-149/T-143) each own independent attachment state.
@Injectable()
export class PendingAttachmentsService {
  private readonly _items = signal<PendingAttachment[]>([]);
  readonly items = this._items.asReadonly();

  /** Truthy when there is at least one attachment queued. */
  get hasAny(): boolean {
    return this._items().length > 0;
  }

  /**
   * Append a fresh attachment. Returns the generated id, or `null` when the
   * blob would exceed the per-file or per-send size cap.
   */
  add(blob: Blob, name: string | null): string | null {
    const total = this._items().reduce((n, a) => n + a.size, 0);
    if (blob.size > MAX_ATTACHMENT_BYTES || total + blob.size > MAX_ATTACHMENTS_TOTAL_BYTES) {
      return null;
    }
    const isImage = blob.type.startsWith('image/');
    const resolvedName = name || (isImage ? `pasted-${Date.now()}.png` : `pasted-${Date.now()}`);
    const id = `att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this._items.update((list) => [
      ...list,
      {
        id,
        name: resolvedName,
        mime: blob.type,
        blob,
        previewUrl: isImage ? URL.createObjectURL(blob) : null,
        kind: attachmentKind(blob.type, resolvedName),
        size: blob.size,
      },
    ]);
    return id;
  }

  /**
   * Replace the list with a snapshot restored from the ComposerDraftStore
   * (S-14). No URL is minted or revoked: the snapshot's blobs and preview
   * URLs are still alive (they only die on send-dispose or store purge),
   * and the current list belongs to another sessionKey whose snapshot the
   * store still references.
   */
  restore(items: readonly PendingAttachment[]): void {
    this._items.set([...items]);
  }

  /** Drop one attachment by id and revoke its preview URL. */
  remove(id: string): void {
    const list = this._items();
    const idx = list.findIndex((a) => a.id === id);
    if (idx === -1) return;
    PendingAttachmentsService.revoke(list[idx]);
    this._items.set([...list.slice(0, idx), ...list.slice(idx + 1)]);
  }

  /**
   * Atomic drain: returns the current snapshot, clears the list, and
   * keeps the preview URLs alive so callers can finish reading the
   * blob buffers before disposing. `disposePreviews(snapshot)` is the
   * caller's responsibility once they're done.
   */
  drain(): PendingAttachment[] {
    const snapshot = this._items();
    this._items.set([]);
    return snapshot;
  }

  /** Revoke every preview URL in the given snapshot. Safe to call on the
   *  result of `drain()` once the IPC payload has been built. */
  disposePreviews(snapshot: readonly PendingAttachment[]): void {
    for (const a of snapshot) PendingAttachmentsService.revoke(a);
  }

  /** Drop every attachment, revoking previews. */
  clear(): void {
    this.disposePreviews(this._items());
    this._items.set([]);
  }

  static revoke(a: PendingAttachment): void {
    if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
  }

  /**
   * Build the IPC payload array from a snapshot. `Blob.arrayBuffer()` is
   * async, so we return a Promise. Consumers typically `await` this
   * right before `sendInstruction()`.
   */
  static async toPayloads(
    snapshot: readonly PendingAttachment[],
  ): Promise<AttachmentPayload[]> {
    return Promise.all(
      snapshot.map(async (a) => ({
        name: a.name,
        mime: a.mime,
        buffer: await a.blob.arrayBuffer(),
      })),
    );
  }
}
