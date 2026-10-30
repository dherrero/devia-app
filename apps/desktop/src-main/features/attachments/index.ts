import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature } from '../../shared/feature';
import type {
  AttachmentEnricher,
  ConfigRepository,
} from '../../shared/ports';
import {
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_ATTACHMENT_BYTES,
  buildAttachmentInstruction,
  describeSavedAttachment,
  formatBytes,
  type AttachmentPayload,
  type SavedAttachment,
} from '../../../shared/domain/attachment';

const MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'text/plain': '.txt',
  'application/json': '.json',
  'application/zip': '.zip',
};

// Keeps letters/digits of any script (accents, CJK…) and drops path
// separators, control chars and shell-hostile punctuation.
export function sanitizeAttachmentName(name: string): string {
  // Split on both separators: a Windows-style name must not keep its
  // directory part when Devia runs on POSIX (and vice versa).
  const base = (name.normalize('NFC').split(/[\\/]/).pop() ?? '')
    .replace(/[^\p{L}\p{N}._\- ]+/gu, '')
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '');
  return base.slice(-120);
}

export class FsAttachmentEnricher implements AttachmentEnricher {
  constructor(private readonly config: Pick<ConfigRepository, 'deviaDir'>) {}

  private attachmentsDir(): string {
    const dir = path.join(this.config.deviaDir(), 'attachments');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  private assertSize(payload: AttachmentPayload): void {
    if (payload.buffer.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new Error(
        `"${payload.name}" ocupa ${formatBytes(payload.buffer.byteLength)}; el máximo por archivo es ${formatBytes(MAX_ATTACHMENT_BYTES)}`,
      );
    }
  }

  save(payload: AttachmentPayload): SavedAttachment {
    this.assertSize(payload);
    const { name, mime, buffer } = payload;
    const ext = path.extname(name) || MIME_EXT[mime] || '.bin';
    const safe = sanitizeAttachmentName(name) || `attachment${ext}`;
    const filename = `${Date.now()}_${safe}${path.extname(safe) ? '' : ext}`;
    const dest = path.join(this.attachmentsDir(), filename);
    fs.writeFileSync(dest, Buffer.from(buffer));
    return { path: dest, name: name || filename, mime, size: buffer.byteLength };
  }

  saveAll(payloads: readonly AttachmentPayload[]): SavedAttachment[] {
    payloads.forEach((p) => this.assertSize(p));
    const total = payloads.reduce((n, p) => n + p.buffer.byteLength, 0);
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      throw new Error(
        `los adjuntos suman ${formatBytes(total)}; el máximo por envío es ${formatBytes(MAX_ATTACHMENTS_TOTAL_BYTES)}`,
      );
    }
    return payloads.map((p) => this.save(p));
  }

  augmentInstruction(text: string, saved: readonly SavedAttachment[]): string {
    return buildAttachmentInstruction(text, saved.map(describeSavedAttachment));
  }
}

export function createAttachmentEnricher(config: ConfigRepository): AttachmentEnricher {
  return new FsAttachmentEnricher(config);
}

/**
 * The attachments feature has no IPC channels of its own — its product
 * surface is the `AttachmentEnricher` port consumed by the claude-runner.
 * It still registers as a `Feature` so the composition root can license-gate
 * it uniformly with everything else.
 */
export function buildAttachmentsFeature(): Feature {
  return {
    id: 'attachments',
    register() { /* no IPC of its own */ },
  };
}
