import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

import type {
  CreateSnapshotRequest,
  SnapshotEntry,
  SnapshotFeature,
  SnapshotManifest,
} from '../../../../shared/domain/snapshot';

/**
 * Filesystem layer for the snapshot feature (#270).
 *
 * Layout under `<deviaDir>/snapshots/<feature>/<id>/`:
 *   manifest.json           — SnapshotManifest
 *   files/<n>.gz            — gzip(content) for each existing entry
 *
 * No tar packaging is used (see shared/domain/snapshot.ts for the
 * rationale). Each captured file is gzipped individually so restore
 * is a straight loop over the manifest entries.
 *
 * Fingerprinting + dedup live alongside the store so the create
 * use case can ask "do we already have a snapshot with this exact
 * input?" before paying the disk cost of compressing the files.
 */

const MANIFEST_FILENAME = 'manifest.json';
const FILES_DIRNAME = 'files';
const EMPTY_FINGERPRINT = crypto.createHash('sha256').update('').digest('hex');

export class SnapshotStore {
  constructor(private readonly deviaDir: () => string) {}

  /** Absolute root of every snapshot. Created on demand. */
  rootDir(): string {
    return path.join(this.deviaDir(), 'snapshots');
  }

  /** Per-feature subdirectory. */
  featureDir(feature: SnapshotFeature): string {
    return path.join(this.rootDir(), feature);
  }

  /** Per-snapshot directory. The id is a millisecond-precision ISO
   *  timestamp + a 6-char random suffix, mostly so the user can scan
   *  the history visually but it's still unique under burst writes. */
  snapshotDir(feature: SnapshotFeature, id: string): string {
    return path.join(this.featureDir(feature), id);
  }

  /**
   * Snapshot every path in `req.paths`. Returns a fully-formed
   * SnapshotManifest; the caller is responsible for the dedup check
   * BEFORE calling write() (we don't return early here because the
   * fingerprint depends on hashing the existing files anyway).
   */
  write(req: CreateSnapshotRequest, id: string): SnapshotManifest {
    const dir = this.snapshotDir(req.feature, id);
    fs.mkdirSync(path.join(dir, FILES_DIRNAME), { recursive: true });

    const entries: SnapshotEntry[] = [];
    const checksums: string[] = [];

    for (const [i, p] of req.paths.entries()) {
      const entry = this.captureOne(p, i, dir);
      entries.push(entry);
      // Fingerprint inputs: per-entry sha256 || 'absent' marker. We
      // hash absolute paths too so two snapshots with the same content
      // for different files don't collide.
      checksums.push(`${p}:${entry.sha256 ?? 'absent'}`);
    }

    const fingerprint = fingerprintOf(checksums);
    const manifest: SnapshotManifest = {
      id,
      createdAt: Date.now(),
      feature: req.feature,
      reason: req.reason,
      ...(req.projectPath !== undefined && { projectPath: req.projectPath }),
      entries,
      fingerprint,
      pinned: false,
    };

    fs.writeFileSync(
      path.join(dir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    return manifest;
  }

  /** Read every manifest under a feature. Defensive: corrupt
   *  manifests are skipped with a warning so a single bad entry
   *  doesn't break the whole history view. */
  listManifests(feature?: SnapshotFeature): SnapshotManifest[] {
    const features: SnapshotFeature[] = feature
      ? [feature]
      : (['skills', 'mcp', 'prompt-packs', 'manual'] as const).slice();

    const out: SnapshotManifest[] = [];
    for (const f of features) {
      const fdir = this.featureDir(f);
      if (!safeIsDir(fdir)) continue;
      let ids: string[];
      try { ids = fs.readdirSync(fdir); } catch { continue; }
      for (const id of ids) {
        const manifestPath = path.join(fdir, id, MANIFEST_FILENAME);
        const manifest = this.readManifest(manifestPath);
        if (manifest) out.push(manifest);
      }
    }
    return out;
  }

  readManifest(manifestPath: string): SnapshotManifest | null {
    let raw: string;
    try { raw = fs.readFileSync(manifestPath, 'utf8'); }
    catch { return null; }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch (err) {
      console.warn(`[snapshot] corrupt manifest ${manifestPath}: ${(err as Error).message}`);
      return null;
    }
    if (!isManifestShape(parsed)) {
      console.warn(`[snapshot] manifest at ${manifestPath} has unexpected shape`);
      return null;
    }
    return parsed;
  }

  /** Reads the manifest by id without scanning every feature dir. */
  readManifestById(feature: SnapshotFeature, id: string): SnapshotManifest | null {
    return this.readManifest(path.join(this.snapshotDir(feature, id), MANIFEST_FILENAME));
  }

  /** Gunzip the captured content of a single entry. Returns null when
   *  the entry never had content (existed === false). */
  readEntryContent(feature: SnapshotFeature, id: string, entry: SnapshotEntry): Buffer | null {
    if (!entry.existed || !entry.archiveName) return null;
    const archivePath = path.join(this.snapshotDir(feature, id), FILES_DIRNAME, entry.archiveName);
    const gz = fs.readFileSync(archivePath);
    return zlib.gunzipSync(gz);
  }

  /** Update an existing manifest in place (pin toggle, retention
   *  bookkeeping). Caller must pass the full manifest. */
  writeManifest(manifest: SnapshotManifest): void {
    fs.writeFileSync(
      path.join(this.snapshotDir(manifest.feature, manifest.id), MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
  }

  /** Recursive delete of a snapshot dir. Best-effort: missing dirs
   *  are not an error. */
  removeSnapshot(feature: SnapshotFeature, id: string): void {
    try {
      fs.rmSync(this.snapshotDir(feature, id), { recursive: true, force: true });
    } catch { /* swallow */ }
  }

  // ── helpers ─────────────────────────────────────────────────────

  /**
   * Capture one file into `<dir>/files/<index>.gz` + return the
   * matching SnapshotEntry. Missing files produce an entry with
   * `existed: false` so restore can re-delete them.
   */
  private captureOne(absPath: string, index: number, dir: string): SnapshotEntry {
    let stat: fs.Stats;
    try { stat = fs.statSync(absPath); }
    catch {
      return { path: absPath, existed: false };
    }
    if (!stat.isFile()) {
      // We only snapshot regular files. Symlinks resolve to their
      // target (statSync follows them); directories are caller error.
      return { path: absPath, existed: false };
    }
    const content = fs.readFileSync(absPath);
    const sha = crypto.createHash('sha256').update(content).digest('hex');
    const archiveName = `${index}.gz`;
    fs.writeFileSync(
      path.join(dir, FILES_DIRNAME, archiveName),
      zlib.gzipSync(content),
    );
    return {
      path: absPath,
      existed: true,
      sha256: sha,
      size: content.length,
      archiveName,
    };
  }
}

// ─── module-level helpers ─────────────────────────────────────────

function fingerprintOf(checksumLines: ReadonlyArray<string>): string {
  if (checksumLines.length === 0) return EMPTY_FINGERPRINT;
  const h = crypto.createHash('sha256');
  for (const line of checksumLines) h.update(`${line}\n`);
  return h.digest('hex');
}

function safeIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function isManifestShape(parsed: unknown): parsed is SnapshotManifest {
  if (parsed === null || typeof parsed !== 'object') return false;
  const m = parsed as Record<string, unknown>;
  return typeof m['id'] === 'string'
    && typeof m['createdAt'] === 'number'
    && typeof m['feature'] === 'string'
    && typeof m['reason'] === 'string'
    && Array.isArray(m['entries'])
    && typeof m['fingerprint'] === 'string'
    && typeof m['pinned'] === 'boolean';
}

/** Public helper exported so the create use case can ask for the
 *  fingerprint without first paying the disk cost. */
export function fingerprintForRequest(req: CreateSnapshotRequest): string {
  const lines: string[] = [];
  for (const p of req.paths) {
    try {
      const stat = fs.statSync(p);
      if (!stat.isFile()) { lines.push(`${p}:absent`); continue; }
      const content = fs.readFileSync(p);
      const sha = crypto.createHash('sha256').update(content).digest('hex');
      lines.push(`${p}:${sha}`);
    } catch {
      lines.push(`${p}:absent`);
    }
  }
  return fingerprintOf(lines);
}

/** Build a fresh, sortable id. ISO ms + 6-char random suffix. */
export function newSnapshotId(now: Date = new Date()): string {
  const iso = now.toISOString().replace(/[-:]/g, '').replace('.', '-');
  const rand = crypto.randomBytes(3).toString('hex');
  return `${iso}-${rand}`;
}
