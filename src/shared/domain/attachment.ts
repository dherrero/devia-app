export interface AttachmentPayload {
  name: string;
  mime: string;
  buffer: ArrayBuffer;
}

/** An attachment persisted to disk, ready to be referenced in the prompt. */
export interface SavedAttachment {
  path: string;
  name: string;
  mime: string;
  size: number;
}

export type OutboxFileKind = 'image' | 'video' | 'file';

export interface OutboxFile {
  project: string;
  name: string;
  kind: OutboxFileKind;
  /** Absolute path of the ARCHIVED copy (`<deviaDir>/outbox-archive/…`). */
  path: string;
  size: number;
  mime: string;
}

// The renderer copies each file through IPC as an ArrayBuffer, so the caps
// bound the memory a single send can pin in both processes.
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 200 * 1024 * 1024;

export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'video'
  | 'audio'
  | 'text'
  | 'archive'
  | 'binary';

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'yaml', 'yml', 'xml', 'html', 'htm',
  'css', 'scss', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cpp', 'hpp', 'cs', 'php', 'sh', 'zsh', 'bash', 'sql', 'log', 'ini', 'toml', 'env',
  'conf', 'cfg', 'dart', 'swift', 'vue', 'svelte', 'graphql', 'proto', 'tex', 'rtf',
]);
const ARCHIVE_EXTS = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'jar', 'war']);

function extOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function attachmentKind(mime: string, name = ''): AttachmentKind {
  const ext = extOf(name);
  if (mime.startsWith('image/')) return 'image';
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (ARCHIVE_EXTS.has(ext) || /zip|x-tar|gzip|x-7z|x-rar|x-bzip/.test(mime)) return 'archive';
  if (mime.startsWith('text/') || TEXT_EXTS.has(ext) || /json|xml|yaml|javascript/.test(mime)) {
    return 'text';
  }
  return 'binary';
}

/** Spanish label the agent reads next to each attachment path. */
export function attachmentKindLabel(kind: AttachmentKind): string {
  switch (kind) {
    case 'image':   return 'Imagen';
    case 'pdf':     return 'PDF';
    case 'video':   return 'Vídeo';
    case 'audio':   return 'Audio';
    case 'text':    return 'Documento';
    case 'archive': return 'Archivo comprimido';
    default:        return 'Binario';
  }
}

export interface AttachedFile {
  label: string;
  path: string;
  /** Read cannot open it: the agent is pointed at shell tools instead. */
  opaque?: boolean;
}

const OPAQUE_HINT =
  'Si Read no puede abrir algún archivo, inspecciónalo con Bash (file, unzip -l, tar -tf, xxd | head…).';

/** Compose the caption + a Read note for each saved attachment path. */
export function buildAttachmentInstruction(caption: string, files: readonly AttachedFile[]): string {
  if (files.length === 0) return caption;
  const hint = files.some((f) => f.opaque) ? ` ${OPAQUE_HINT}` : '';
  if (files.length === 1) {
    const only = files[0];
    if (!only) return caption;
    return `${caption}\n\n[Adjunto (${only.label}) disponible en \`${only.path}\`. Léelo con la herramienta Read antes de responder.${hint}]`;
  }
  const lines = files.map((f) => `- ${f.label}: \`${f.path}\``).join('\n');
  return `${caption}\n\n[Archivos adjuntos (léelos con la herramienta Read antes de responder):\n${lines}${hint ? `\n${hint.trim()}` : ''}]`;
}

/** The `AttachedFile` note entry for a file saved by the enricher. */
export function describeSavedAttachment(saved: SavedAttachment): AttachedFile {
  const kind = attachmentKind(saved.mime, saved.name);
  return {
    label: attachmentKindLabel(kind),
    path: saved.path,
    ...((kind === 'archive' || kind === 'binary' || kind === 'video' || kind === 'audio') && { opaque: true }),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
