import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature } from '../../shared/feature';
import type {
  ConfigRepository,
  FlushedOutboxFile,
  OutboxEntry,
  OutboxFlusher,
} from '../../shared/ports';
import { mimeFromName } from '../../../shared/domain/outbound-file-policy';
import type { OutboxFileKind } from '../../../shared/domain/attachment';

const IMAGE_EXTS: ReadonlySet<string> = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXTS: ReadonlySet<string> = new Set(['.mp4', '.mov', '.avi', '.mkv', '.webm']);

class FsOutboxFlusher implements OutboxFlusher {
  constructor(private readonly config: ConfigRepository) {}

  private archiveDir(): string {
    return path.join(this.config.deviaDir(), 'outbox-archive');
  }

  private classify(filename: string): OutboxFileKind {
    const ext = path.extname(filename).toLowerCase();
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    return 'file';
  }

  private moveToArchive(src: string, filename: string): string {
    const dir = this.archiveDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, `${Date.now()}_${filename}`);
    try {
      fs.renameSync(src, dest);
    } catch {
      // Cross-filesystem fallback.
      fs.cpSync(src, dest);
      fs.unlinkSync(src);
    }
    return dest;
  }

  flush<T = never>(projectPath: string, check?: (entry: OutboxEntry) => T): FlushedOutboxFile<T>[] {
    if (!path.isAbsolute(projectPath)) return [];
    const outboxDir = path.join(projectPath, 'outbox');

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(outboxDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const project = path.basename(projectPath);
    const flushed: FlushedOutboxFile<T>[] = [];
    for (const entry of entries) {
      const filename = entry.name;
      const src = path.join(outboxDir, filename);
      // Only a regular file is offered to `check`: a symlink is archived as a
      // link, so whatever the check approved could change under it later.
      const isRegular = entry.isFile();
      if (!isRegular && !(entry.isSymbolicLink() && isFileTarget(src))) continue;
      try {
        const verdict = isRegular && check ? check({ path: src, name: filename }) : undefined;
        const archivedPath = this.moveToArchive(src, filename);
        flushed.push({
          file: {
            project,
            name: filename,
            kind: this.classify(filename),
            path: archivedPath,
            size: sizeOf(archivedPath),
            mime: mimeFromName(filename),
          },
          ...(verdict !== undefined && { verdict }),
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[outbox] archive failed for', filename, message);
      }
    }
    return flushed;
  }
}

function isFileTarget(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function sizeOf(p: string): number {
  try {
    return fs.lstatSync(p).size;
  } catch {
    return 0;
  }
}

export function createOutboxFlusher(config: ConfigRepository): OutboxFlusher {
  return new FsOutboxFlusher(config);
}

export function buildOutboxFeature(): Feature {
  return {
    id: 'outbox',
    register() { /* no IPC of its own */ },
  };
}
