/**
 * Labels for Telegram attachments (E-DSK-14). The files are downloaded and
 * saved locally, and the note appended to the caption is the same one the
 * desktop composer produces (`buildAttachmentInstruction`).
 */

export { buildAttachmentInstruction, type AttachedFile } from '../../../../shared/domain/attachment';

export type RemoteMediaKind = 'photo' | 'document' | 'video' | 'audio' | 'voice';

/** Human-readable label for a media kind (Spanish, user-facing). */
export function attachmentLabel(kind: RemoteMediaKind, mime?: string): string {
  switch (kind) {
    case 'photo': return 'Imagen';
    case 'video': return 'Vídeo';
    case 'audio':
    case 'voice': return 'Audio';
    default:      return mime?.includes('pdf') ? 'PDF' : 'Documento';
  }
}
