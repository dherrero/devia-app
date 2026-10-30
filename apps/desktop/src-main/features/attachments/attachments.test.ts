import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsAttachmentEnricher, sanitizeAttachmentName } from './index';
import {
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  attachmentKind,
  type AttachmentPayload,
} from '../../../shared/domain/attachment';

const payload = (name: string, mime: string, bytes = 4): AttachmentPayload => ({
  name,
  mime,
  buffer: new Uint8Array(bytes).fill(7).buffer,
});

// A fake buffer whose only job is to report a size: the caps are checked
// before anything touches its contents.
const sized = (name: string, byteLength: number): AttachmentPayload => ({
  name,
  mime: 'application/octet-stream',
  buffer: { byteLength } as ArrayBuffer,
});

describe('FsAttachmentEnricher', () => {
  let dir: string;
  let enricher: FsAttachmentEnricher;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-att-'));
    enricher = new FsAttachmentEnricher({ deviaDir: () => dir });
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('saves any binary and returns its metadata', () => {
    const saved = enricher.save(payload('modelo.bin', 'application/octet-stream', 16));
    expect(fs.readFileSync(saved.path).length).toBe(16);
    expect(saved).toMatchObject({ name: 'modelo.bin', mime: 'application/octet-stream', size: 16 });
    expect(path.dirname(saved.path)).toBe(path.join(dir, 'attachments'));
  });

  it('keeps unicode names and the extension', () => {
    const saved = enricher.save(payload('informe año 2026.pdf', 'application/pdf'));
    expect(path.basename(saved.path)).toMatch(/^\d+_informe_año_2026\.pdf$/);
  });

  it('never lets a name escape the attachments dir', () => {
    const saved = enricher.save(payload('../../etc/passwd', 'text/plain'));
    expect(path.dirname(saved.path)).toBe(path.join(dir, 'attachments'));
  });

  it('falls back to an extension from the mime', () => {
    const saved = enricher.save(payload('', 'image/png'));
    expect(saved.path.endsWith('_attachment.png')).toBe(true);
  });

  it('rejects a file over the per-file cap', () => {
    expect(() => enricher.save(sized('big.iso', MAX_ATTACHMENT_BYTES + 1))).toThrow(/big\.iso/);
  });

  it('rejects a batch over the total cap without writing anything', () => {
    const n = Math.ceil(MAX_ATTACHMENTS_TOTAL_BYTES / MAX_ATTACHMENT_BYTES) + 1;
    const batch = Array.from({ length: n }, (_, i) => sized(`p${i}.bin`, MAX_ATTACHMENT_BYTES));
    expect(() => enricher.saveAll(batch)).toThrow(/máximo por envío/);
    expect(fs.existsSync(path.join(dir, 'attachments'))).toBe(false);
  });

  it('labels each file by kind and hints shell tools for opaque ones', () => {
    const saved = enricher.saveAll([payload('a.png', 'image/png'), payload('b.zip', 'application/zip')]);
    const out = enricher.augmentInstruction('mira', saved);
    expect(out).toContain(`- Imagen: \`${saved[0]!.path}\``);
    expect(out).toContain(`- Archivo comprimido: \`${saved[1]!.path}\``);
    expect(out).toContain('Bash');
  });

  it('leaves the instruction untouched with no attachments', () => {
    expect(enricher.augmentInstruction('hola', [])).toBe('hola');
  });
});

describe('sanitizeAttachmentName', () => {
  it('strips separators and hostile punctuation', () => {
    expect(sanitizeAttachmentName('a/b\\c;rm -rf $(x).txt')).toBe('crm_-rf_x.txt');
  });
});

describe('attachmentKind', () => {
  it.each([
    ['image/png', 'a.png', 'image'],
    ['application/pdf', 'a.pdf', 'pdf'],
    ['', 'a.pdf', 'pdf'],
    ['video/mp4', 'a.mp4', 'video'],
    ['audio/ogg', 'a.ogg', 'audio'],
    ['application/zip', 'a.zip', 'archive'],
    ['', 'src.tar', 'archive'],
    ['text/csv', 'a.csv', 'text'],
    ['', 'main.ts', 'text'],
    ['application/json', 'x', 'text'],
    ['application/octet-stream', 'a.sqlite', 'binary'],
  ])('%s %s → %s', (mime, name, kind) => {
    expect(attachmentKind(mime, name)).toBe(kind);
  });
});
