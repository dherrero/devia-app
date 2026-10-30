import { Injectable } from '@angular/core';
import type { PendingAttachment } from '../chat-panel/models/pending-attachment.model';

/** Unsent composer state preserved across chat-route remounts (S-14). */
export interface ComposerDraftSnapshot {
  readonly draft: string;
  readonly attachments: readonly PendingAttachment[];
}

/**
 * Per-session store of unsent composer drafts (S-14).
 *
 * Root-scoped for the same reason as `PanesLayoutStore`: every
 * `ChatPanelComponent` is destroyed when the user leaves the chat route
 * (Kanban, settings, etc.) and recreated on return, so the draft signal it
 * owns dies with it. Keying by the pane's `sessionKey` (base project for the
 * primary pane, sessionId for additional split panes) gives each of the 1–4
 * panes its own isolated draft.
 *
 * Memory-only by design: a draft survives in-app navigation, not an app
 * restart. Attachment preview object-URLs stay valid across route changes
 * because the document never reloads — `purge()` is the only path that
 * revokes them, for panes whose composer will never come back.
 */
@Injectable({ providedIn: 'root' })
export class ComposerDraftStore {
  private readonly byKey = new Map<string, ComposerDraftSnapshot>();
  // Keys purged by a pane close whose composer is destroyed AFTERWARDS (the
  // container purges, then Angular tears the panel down and its destroy-save
  // fires) — without the tombstone that late save would resurrect the entry.
  // A `snapshot()` read reopens the key: only a remounting composer for the
  // same session ever reads it, which is exactly when saves become legit again.
  private readonly closed = new Set<string>();

  snapshot(key: string): ComposerDraftSnapshot | null {
    this.closed.delete(key);
    return this.byKey.get(key) ?? null;
  }

  /** Upsert the draft for `key`. An empty snapshot deletes the entry so the
   *  store never accumulates blank drafts. Ignored for a purged key until a
   *  composer remounts on it (see `closed`). */
  save(key: string, snapshot: ComposerDraftSnapshot): void {
    if (!key || this.closed.has(key)) return;
    if (snapshot.draft === '' && snapshot.attachments.length === 0) {
      this.byKey.delete(key);
      return;
    }
    this.byKey.set(key, snapshot);
  }

  /** Drop the entry WITHOUT revoking preview URLs — the live composer still
   *  owns the attachments (send path drains and disposes them itself). */
  clear(key: string): void {
    this.byKey.delete(key);
  }

  /** Drop the entry AND revoke its attachment preview URLs — for a closed
   *  pane/session whose composer will never remount to reclaim them. */
  purge(key: string): void {
    this.closed.add(key);
    const snap = this.byKey.get(key);
    if (!snap) return;
    for (const a of snap.attachments) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    this.byKey.delete(key);
  }
}
