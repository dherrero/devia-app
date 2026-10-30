import type { AttachmentPayload, SavedAttachment } from '../../../shared/domain/attachment';

/**
 * Owned by the `attachments` feature. The claude-runner consumes it to
 * persist user-attached files and rewrite the user's instruction with the
 * saved paths before spawning Claude. Kept behind a port so disabling the
 * attachments feature degrades to a no-op enrichment instead of breaking
 * `instruction:send`.
 */
export interface AttachmentEnricher {
  save(payload: AttachmentPayload): SavedAttachment;
  /** Validates the size caps for the whole batch BEFORE writing any file. */
  saveAll(payloads: readonly AttachmentPayload[]): SavedAttachment[];
  augmentInstruction(instruction: string, saved: readonly SavedAttachment[]): string;
}
