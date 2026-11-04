import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const PIN_FILE = 'VERSION.json';
const MARKER = '.devia-managed.json';

export interface KitPin {
  repo: string;
  tag: string;
  commit: string;
  sha256: string;
}

export function readKitPin(dir: string): KitPin | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, PIN_FILE), 'utf8')) as Partial<KitPin>;
    if (typeof raw.repo !== 'string' || typeof raw.tag !== 'string' || typeof raw.commit !== 'string' || typeof raw.sha256 !== 'string') return null;
    return { repo: raw.repo, tag: raw.tag, commit: raw.commit, sha256: raw.sha256 };
  } catch {
    return null;
  }
}

function listFiles(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...listFiles(root, next));
    else if (entry.isFile() && next !== PIN_FILE && next !== MARKER) out.push(next);
  }
  return out;
}

/** Same algorithm as `scripts/vendor-superpowers.mjs` (paths + contents, never modes). */
export function hashKitTree(dir: string): string {
  const h = createHash('sha256');
  for (const f of listFiles(dir).sort()) {
    h.update(`${f}\0${createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}\n`);
  }
  return h.digest('hex');
}

function runnable(rel: string, content: Buffer): boolean {
  return rel.startsWith('hooks/') || content.subarray(0, 2).toString() === '#!';
}

function setTreeMode(dir: string, writable: boolean): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) setTreeMode(p, writable);
  }
  fs.chmodSync(dir, writable ? 0o755 : 0o555);
}

function removeTree(dir: string): void {
  try {
    if (fs.existsSync(dir)) setTreeMode(dir, true);
  } catch { /* best effort: rm below reports what is left */ }
  fs.rmSync(dir, { recursive: true, force: true });
}

export interface MaterializedKit {
  dir: string;
  pin: KitPin;
}

/**
 * Copies the bundled kit to `<targetRoot>/<tag>-<hash>/` with read-only FILES:
 * it is managed content, and an agent (or a user) editing it would silently
 * change the methodology for every project. Directories stay writable on
 * purpose — a read-only tree makes `rm -rf ~/.devia-app` fail for the user. Idempotent — a directory
 * already holding the same hash is reused untouched. The hook scripts and
 * every `#!` file keep an execute bit, which a packager or Windows checkout
 * may have dropped (the Claude plugin hook is run without `bash`).
 *
 * Throws when the bundle does not match its own pin: shipping an edited skill
 * is exactly what the vendoring pin exists to prevent.
 */
export function materializeKit(sourceDir: string, targetRoot: string): MaterializedKit {
  const pin = readKitPin(sourceDir);
  if (!pin) throw new Error(`kit at ${sourceDir} has no valid ${PIN_FILE}`);
  const actual = hashKitTree(sourceDir);
  if (actual !== pin.sha256) throw new Error(`kit ${pin.tag} does not match its pin (${actual} != ${pin.sha256})`);

  const target = path.join(targetRoot, `${pin.tag}-${pin.sha256.slice(0, 12)}`);
  const marker = path.join(target, MARKER);
  if (fs.existsSync(marker) && hashKitTree(target) === pin.sha256) {
    pruneOthers(targetRoot, target);
    return { dir: target, pin };
  }

  removeTree(target);
  const staging = `${target}.tmp-${process.pid}`;
  removeTree(staging);
  fs.mkdirSync(staging, { recursive: true });
  for (const rel of listFiles(sourceDir)) {
    const content = fs.readFileSync(path.join(sourceDir, rel));
    const to = path.join(staging, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, content, { mode: runnable(rel, content) ? 0o555 : 0o444 });
    fs.chmodSync(to, runnable(rel, content) ? 0o555 : 0o444);
  }
  fs.copyFileSync(path.join(sourceDir, PIN_FILE), path.join(staging, PIN_FILE));
  fs.writeFileSync(path.join(staging, MARKER), `${JSON.stringify({ kit: 'superpowers', tag: pin.tag, commit: pin.commit })}\n`);
  fs.renameSync(staging, target);
  pruneOthers(targetRoot, target);
  return { dir: target, pin };
}

function pruneOthers(targetRoot: string, keep: string): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(targetRoot, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const p = path.join(targetRoot, entry.name);
    if (entry.isDirectory() && p !== keep) removeTree(p);
  }
}
