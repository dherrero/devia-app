import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BootstrapView } from '../../../../shared/domain/sdd';
import { execFileSyncOnPath } from '../../cli-adapters/infrastructure/path-command';

/**
 * First-contact project classification (E-DSK-12 T2 / SDD-F1).
 *
 * The source of truth for "is this a new project?" is a persisted
 * boolean `newProject` in the per-project devia cache — NOT a
 * commit-count heuristic. The flag is:
 *   - written `true`  when a project is created with "+" (blank/base),
 *   - written `false` for an imported/existing repo,
 *   - flipped `false` once the spec or a conversation starts.
 *
 * `detect` reports the resulting classification so the renderer can
 * route init (new) vs prepare (existing). It no longer surfaces a
 * "new vs existing" chooser — the modal just asks the user's intent.
 *
 * git is invoked through the shared PATH-aware helper to materialise a repo
 * when one is absent; commit counting was removed.
 */

export type BootstrapResult = BootstrapView;

interface BootstrapMarker {
  readonly version: number;
  readonly newProject: boolean;
  readonly at: number;
}

const MARKER_VERSION = 2;

export class BootstrapDetector {
  constructor(private readonly deviaDir: () => string) {}

  /** Cache marker file holding the `newProject` flag. Lives next to the
   *  kanban store so removing the project dir resets it. */
  private bootstrapMarker(projectPath: string): string {
    const key = projectPath.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return path.join(this.deviaDir(), 'projects', key, 'bootstrap.json');
  }

  hasBootstrapped(projectPath: string): boolean {
    return this.readMarker(projectPath) !== null;
  }

  /**
   * Run detection. When `force` is false and a marker exists, returns
   * `alreadyBootstrapped: true` so the caller skips the auto-modal; the
   * classification still reflects the persisted `newProject` flag. With
   * `force` (or no marker), git is materialised if missing and the view
   * is returned so the modal can open.
   */
  detect(projectPath: string, opts: { force?: boolean } = {}): BootstrapResult {
    const marker = this.readMarker(projectPath);

    if (!opts.force && marker) {
      return {
        classification: marker.newProject ? 'new' : 'existing',
        gitInitialised: false,
        alreadyBootstrapped: true,
      };
    }

    let gitInitialised = false;
    if (!this.hasGit(projectPath)) {
      this.gitInit(projectPath);
      gitInitialised = true;
    }

    // Default for an unseen project: treat as existing. Only an explicit
    // `newProject: true` flag (set at "+"-creation) makes it "new".
    const isNew = marker?.newProject ?? false;
    return {
      classification: isNew ? 'new' : 'existing',
      gitInitialised,
      alreadyBootstrapped: false,
    };
  }

  /** Record a project at "+"-creation time. `isNew` is true for a
   *  blank/base project, false for an imported (existing) repo. */
  markCreated(projectPath: string, isNew: boolean): void {
    this.writeMarker(projectPath, isNew);
  }

  /** Flip `newProject` to false once the spec or a conversation starts.
   *  Idempotent — creates the marker if it was absent. */
  markEngaged(projectPath: string): void {
    this.writeMarker(projectPath, false);
  }

  // ── marker persistence ──────────────────────────────────────────

  private readMarker(projectPath: string): BootstrapMarker | null {
    try {
      const raw = fs.readFileSync(this.bootstrapMarker(projectPath), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      if (typeof parsed['newProject'] === 'boolean') {
        return {
          version: typeof parsed['version'] === 'number' ? parsed['version'] : MARKER_VERSION,
          newProject: parsed['newProject'],
          at: typeof parsed['at'] === 'number' ? parsed['at'] : 0,
        };
      }
      // Legacy v1 marker { classification } → derive the flag.
      if (parsed['classification'] === 'new' || parsed['classification'] === 'existing') {
        return {
          version: 1,
          newProject: parsed['classification'] === 'new',
          at: typeof parsed['at'] === 'number' ? parsed['at'] : 0,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private writeMarker(projectPath: string, newProject: boolean): void {
    const file = this.bootstrapMarker(projectPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const marker: BootstrapMarker = { version: MARKER_VERSION, newProject, at: Date.now() };
    fs.writeFileSync(file, JSON.stringify(marker, null, 2), 'utf8');
  }

  // ── git helpers ─────────────────────────────────────────────────

  private hasGit(projectPath: string): boolean {
    try { return fs.statSync(path.join(projectPath, '.git')).isDirectory(); }
    catch { return false; }
  }

  private gitInit(projectPath: string): void {
    try {
      execFileSyncOnPath('git', ['init'], { cwd: projectPath, stdio: 'ignore' });
    } catch (err) {
      console.warn('[sdd:bootstrap] git init failed:', (err as Error).message);
    }
  }
}
