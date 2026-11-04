#!/usr/bin/env node
// Vendors the Superpowers plugin (MIT, github.com/obra/superpowers) into
// resources/kits/superpowers, pinned to an exact tag + commit.
//
// Usage:
//   node scripts/vendor-superpowers.mjs                  clone the pinned tag and re-vendor
//   node scripts/vendor-superpowers.mjs --source <dir>   use a local checkout (must be at the pinned commit)
//   node scripts/vendor-superpowers.mjs --tag v7.1.0     bump the pin to another tag
//   node scripts/vendor-superpowers.mjs --check          verify the vendored tree against its pin (offline)
//
// Skill bodies are never edited: upstream's contributor rules forbid it and a
// pristine copy is what makes updates a plain re-run.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

const REPO_URL = 'https://github.com/obra/superpowers';
const PIN_FILE = 'VERSION.json';

/** What Devia ships: the Claude plugin shell (so `--plugin-dir` works) plus the skills. */
export const INCLUDE = [
  '.claude-plugin/plugin.json',
  'hooks/hooks.json',
  'hooks/run-hook.cmd',
  'hooks/session-start',
  'skills',
  'LICENSE',
];

/**
 * Left out on purpose: diagnosing-superpowers reads other CLIs' transcripts and
 * can open GitHub issues; the rest is upstream's own skill-testing material.
 */
export function isExcluded(rel) {
  const p = rel.split(path.sep).join('/');
  const base = path.posix.basename(p);
  return (
    p === 'skills/diagnosing-superpowers' ||
    p.startsWith('skills/diagnosing-superpowers/') ||
    /^test-.*\.md$/.test(base) ||
    base === 'CREATION-LOG.md' ||
    base === '.DS_Store'
  );
}

function walk(root, rel, out) {
  const abs = path.join(root, rel);
  const stat = fs.lstatSync(abs);
  if (isExcluded(rel)) return;
  if (stat.isSymbolicLink()) throw new Error(`refusing symlink in vendored tree: ${rel}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(abs).sort()) walk(root, path.join(rel, name), out);
  } else if (stat.isFile()) {
    out.push(rel.split(path.sep).join('/'));
  }
}

/** Relative posix paths of every file the kit contains, sorted. */
export function listKitFiles(root, include = INCLUDE) {
  const out = [];
  for (const rel of include) {
    if (!fs.existsSync(path.join(root, rel))) throw new Error(`missing in source: ${rel}`);
    walk(root, rel, out);
  }
  return out.sort();
}

/** Platform-stable digest: paths + contents, never modes or the pin file itself. */
export function treeHash(dir) {
  const files = [];
  const collect = (rel) => {
    for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const next = path.join(rel, entry.name);
      if (entry.isDirectory()) collect(next);
      else if (entry.isFile() && next !== PIN_FILE) files.push(next.split(path.sep).join('/'));
    }
  };
  collect('');
  const h = createHash('sha256');
  for (const f of files.sort()) {
    h.update(`${f}\0${createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}\n`);
  }
  return h.digest('hex');
}

export function readPin(dest) {
  const pin = JSON.parse(fs.readFileSync(path.join(dest, PIN_FILE), 'utf8'));
  for (const key of ['repo', 'tag', 'commit']) {
    if (typeof pin[key] !== 'string' || !pin[key]) throw new Error(`${PIN_FILE}: missing "${key}"`);
  }
  return pin;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** Copies the allowlisted files, replacing `dest` but keeping its pin file for the caller to rewrite. */
export function syncKit(source, dest) {
  const files = listKitFiles(source);
  const pinText = fs.existsSync(path.join(dest, PIN_FILE)) ? fs.readFileSync(path.join(dest, PIN_FILE)) : null;
  fs.rmSync(dest, { recursive: true, force: true });
  for (const rel of files) {
    const to = path.join(dest, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(source, rel), to);
  }
  if (pinText) fs.writeFileSync(path.join(dest, PIN_FILE), pinText);
  return files;
}

/**
 * Re-vendors `dest` from `source` (a checkout). The checkout's HEAD must be the
 * pinned commit unless the caller is bumping the pin (`bumpTag`).
 */
export function vendor({ source, dest, bumpTag }) {
  const pin = readPin(dest);
  const head = git(source, 'rev-parse', 'HEAD');
  if (!bumpTag && head !== pin.commit) {
    throw new Error(`source is at ${head}, the pin is ${pin.commit} (${pin.tag}); use --tag to bump the pin`);
  }
  const files = syncKit(source, dest);
  const next = { repo: pin.repo, tag: bumpTag ?? pin.tag, commit: head };
  fs.writeFileSync(path.join(dest, PIN_FILE), `${JSON.stringify({ ...next, sha256: treeHash(dest) }, null, 2)}\n`);
  return { ...next, files: files.length };
}

/** Offline integrity check: the vendored tree must still hash to what the pin recorded. */
export function checkKit(dest) {
  const pin = readPin(dest);
  const actual = treeHash(dest);
  if (pin.sha256 !== actual) {
    throw new Error(`vendored kit drifted from its pin (${pin.tag}): expected ${pin.sha256}, got ${actual}`);
  }
  return pin;
}

function cloneAt(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'superpowers-vendor-'));
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, REPO_URL, tmp], { stdio: 'inherit' });
  return tmp;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] ?? '' : undefined;
}

function main() {
  const dest = path.resolve(import.meta.dirname, '..', 'resources', 'kits', 'superpowers');
  if (process.argv.includes('--check')) {
    const pin = checkKit(dest);
    console.log(`superpowers kit OK (${pin.tag} @ ${pin.commit.slice(0, 7)})`);
    return;
  }
  const bumpTag = arg('tag');
  const localSource = arg('source');
  const source = localSource ? path.resolve(localSource) : cloneAt(bumpTag ?? readPin(dest).tag);
  try {
    const result = vendor({ source, dest, ...(bumpTag && { bumpTag }) });
    console.log(`vendored superpowers ${result.tag} @ ${result.commit.slice(0, 7)} (${result.files} files)`);
  } finally {
    if (!localSource) fs.rmSync(source, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
