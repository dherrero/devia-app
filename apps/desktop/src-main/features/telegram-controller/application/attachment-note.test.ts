import { describe, it, expect } from 'vitest';
import { attachmentLabel, buildAttachmentInstruction } from './attachment-note';

describe('attachmentLabel', () => {
  it('maps kinds to Spanish labels', () => {
    expect(attachmentLabel('photo')).toBe('Imagen');
    expect(attachmentLabel('video')).toBe('Vídeo');
    expect(attachmentLabel('audio')).toBe('Audio');
    expect(attachmentLabel('voice')).toBe('Audio');
    expect(attachmentLabel('document')).toBe('Documento');
    expect(attachmentLabel('document', 'application/pdf')).toBe('PDF');
  });
});

describe('buildAttachmentInstruction', () => {
  it('returns the caption unchanged with no files', () => {
    expect(buildAttachmentInstruction('hola', [])).toBe('hola');
  });

  it('appends a single Read note', () => {
    const out = buildAttachmentInstruction('describe esto', [{ label: 'Imagen', path: '/p/a.jpg' }]);
    expect(out).toContain('describe esto');
    expect(out).toContain('Adjunto (Imagen) disponible en `/p/a.jpg`');
    expect(out).toContain('Read');
    expect(out).not.toContain('Bash');
  });

  it('points at shell tools when a file is opaque to Read', () => {
    const out = buildAttachmentInstruction('mira', [{ label: 'Binario', path: '/p/a.bin', opaque: true }]);
    expect(out).toContain('Bash');
  });

  it('lists multiple files', () => {
    const out = buildAttachmentInstruction('mira', [
      { label: 'Imagen', path: '/p/a.jpg' },
      { label: 'PDF', path: '/p/b.pdf' },
    ]);
    expect(out).toContain('Archivos adjuntos');
    expect(out).toContain('- Imagen: `/p/a.jpg`');
    expect(out).toContain('- PDF: `/p/b.pdf`');
  });
});
