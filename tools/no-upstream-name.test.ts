import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Devia Method is Devia's own product: it started from an open-source skills library (credited in NOTICE) but
 * nothing a user, an agent or a contributor reads should be named after it. This keeps the name from coming
 * back through a copy-paste.
 *
 * Allowed on purpose, and nowhere else:
 *   - NOTICE: the licence requires the original author's notice to travel with the work.
 *   - vendor/: the pristine third-party copy, with its own text.
 *   - third-party-methods.ts: the names of OTHER people's installs, which Devia must recognise on their disk.
 *   - CHANGELOG.md: generated from commit subjects at release time.
 */
const ROOT = path.resolve(__dirname, '..');
const NAME = new RegExp(['super', 'powers'].join(''), 'i');

const SCANNED = ['src', 'scripts', 'tools', 'resources', 'docs', 'build', 'tests', '.github', 'AGENTS.md', 'CLAUDE.md', 'CONTRIBUTING.md', 'README.md', 'README.en.md', 'package.json'];
const ALLOWED_FILES = new Set(['src/main/features/starter-kits/infrastructure/third-party-methods.ts']);
const SKIP_DIRS = new Set(['node_modules', 'dist', 'release', 'coverage', '.angular', 'snapshots']);

function walk(rel: string): string[] {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [rel];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory() && SKIP_DIRS.has(e.name)) return [];
    return walk(path.join(rel, e.name));
  });
}

const files = SCANNED.flatMap(walk).map((f) => f.split(path.sep).join('/'));

describe('the name of the library Devia Method started from', () => {
  it('scans a meaningful part of the repository', () => {
    expect(files.length).toBeGreaterThan(300);
  });

  it('appears in no file path outside vendor/', () => {
    expect(files.filter((f) => NAME.test(f))).toEqual([]);
  });

  it('appears in no file content except the allowed ones', () => {
    const hits = files.filter((f) => {
      if (ALLOWED_FILES.has(f)) return false;
      let text: string;
      try {
        text = fs.readFileSync(path.join(ROOT, f), 'utf8');
      } catch {
        return false;
      }
      return NAME.test(text);
    });
    expect(hits).toEqual([]);
  });
});
