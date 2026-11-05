#!/usr/bin/env node
// What changed upstream since Devia Method forked a skill, so improvements can be ported by hand.
//
//   node scripts/kit-upstream-diff.mjs --tag v7.1.0            clone upstream and diff the pinned commit against the tag
//   node scripts/kit-upstream-diff.mjs --tag v7.1.0 --source <local clone>   use a local clone
//
// `literal` skills are not listed: they update with `npm run vendor:upstream -- --tag vX` + `npm run kit:build`.
// `derived` skills are Devia's own text, so each upstream change is a decision, not a copy.

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { readManifest } from './build-devia-kit.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });

/** One entry per derived skill: the upstream diff between the fork commit and `ref`, empty when untouched. */
export function upstreamChanges(manifest, repoDir, ref) {
  const base = manifest.upstream.commit;
  return manifest.skills
    .filter((s) => s.origin === 'derived')
    .map((s) => ({ name: s.name, from: s.from, diff: git(repoDir, 'diff', `${base}..${ref}`, '--', `skills/${s.from}`).trim() }));
}

/** The repository is recorded once, in the vendored snapshot's pin. */
function upstreamRepo() {
  const pin = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, '..', 'vendor', 'upstream', 'VERSION.json'), 'utf8'));
  return pin.repo;
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

function main() {
  const tag = arg('tag');
  if (!tag) throw new Error('usage: kit-upstream-diff --tag <vX.Y.Z> [--source <local clone>]');
  const manifest = readManifest(path.resolve(import.meta.dirname, '..', 'resources', 'kits', 'devia-method'));
  const local = arg('source');
  const repoDir = local ? path.resolve(local) : fs.mkdtempSync(path.join(os.tmpdir(), 'upstream-diff-'));
  try {
    if (!local) execFileSync('git', ['clone', '--quiet', upstreamRepo(), repoDir], { stdio: 'inherit' });
    const changes = upstreamChanges(manifest, repoDir, tag);
    const touched = changes.filter((c) => c.diff);
    console.log(`Upstream ${manifest.upstream.tag} (${manifest.upstream.commit.slice(0, 7)}) → ${tag}: ${touched.length}/${changes.length} derived skills changed\n`);
    for (const c of changes) {
      console.log(`## ${c.name}  (skills/${c.from})`);
      console.log(c.diff || '(no upstream changes)');
      console.log();
    }
  } finally {
    if (!local) fs.rmSync(repoDir, { recursive: true, force: true });
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
