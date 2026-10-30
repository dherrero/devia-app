import type { AttachmentKind } from '../../../../../../shared/domain/attachment';

/**
 * In-flight file attachment in the composer (drag-drop / paste / picker,
 * before `sendInstruction` ships it to the main process).
 *
 * `previewUrl` exists only for images: it is an object URL created with
 * `URL.createObjectURL(blob)` — owners MUST `URL.revokeObjectURL(previewUrl)`
 * when removing the entry to avoid blob retention. The mime is preserved so
 * the IPC payload can be reconstructed without a second `Blob.type` read
 * after the buffer is extracted.
 */
export interface PendingAttachment {
  readonly id: string;
  readonly name: string;
  readonly mime: string;
  readonly blob: Blob;
  readonly previewUrl: string | null;
  readonly kind: AttachmentKind;
  readonly size: number;
}
