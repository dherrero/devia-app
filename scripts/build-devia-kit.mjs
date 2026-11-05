#!/usr/bin/env node
// Builds / verifies the Devia Method kit (resources/kits/devia-method).
//
//   node scripts/build-devia-kit.mjs           copy the upstream-derived files, regenerate UPSTREAM.md + VERSION.json
//   node scripts/build-devia-kit.mjs --check   verify the committed kit is exactly what a build would produce
//
// The kit is two kinds of file, told apart by `kit.json`:
//   - COPIED from the pinned upstream snapshot (vendor/upstream): every file of a `literal` or `derived` skill that
//     is not listed under `own` or `drop`. They are never edited by hand: --check fails when one differs.
//   - OWNED by Devia (`own`): authored in place. Their provenance and what changed is the `note` in kit.json, which
//     is the single source of UPSTREAM.md.
// The only text change made to a copied file is dropping the `<namespace>:` prefix of a cross-reference to a skill
// (`ns:test-driven-development`), which would name a skill that does not exist here.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const KIT_LEVEL_FILES = ['kit.json', 'VERSION.json', 'UPSTREAM.md', 'LICENSE', '.claude-plugin/plugin.json'];
const PIN_FILE = 'VERSION.json';
const ORIGINS = ['literal', 'derived', 'own'];

export function readManifest(kitDir) {
  const manifest = JSON.parse(fs.readFileSync(path.join(kitDir, 'kit.json'), 'utf8'));
  for (const key of ['id', 'name', 'version', 'bootstrap', 'upstream', 'skills']) {
    if (manifest[key] === undefined) throw new Error(`kit.json: missing "${key}"`);
  }
  const names = new Set();
  for (const s of manifest.skills) {
    if (!ORIGINS.includes(s.origin)) throw new Error(`kit.json: ${s.name}: origin must be one of ${ORIGINS.join(', ')}`);
    if (names.has(s.name)) throw new Error(`kit.json: duplicate skill ${s.name}`);
    names.add(s.name);
    if (s.origin !== 'own' && !s.from) throw new Error(`kit.json: ${s.name}: "from" is required for ${s.origin}`);
    if (!s.trigger) throw new Error(`kit.json: ${s.name}: "trigger" is required`);
  }
  if (!names.has(manifest.bootstrap)) throw new Error(`kit.json: bootstrap skill "${manifest.bootstrap}" is not in skills`);
  return manifest;
}

/** Drops the namespace prefix of a cross-reference to a skill of the kit: `ns:brainstorming` → `brainstorming`. */
export function transform(text, skillNames) {
  const names = [...new Set(skillNames)].map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return text.replace(new RegExp(`\\b[a-z][a-z0-9-]*:(?=(?:${names.join('|')})\\b)`, 'g'), '');
}

/** Every skill name a copied file may cross-reference: the kit's own and the upstream names they come from. */
function referencedNames(manifest) {
  return manifest.skills.flatMap((s) => (s.from ? [s.name, s.from] : [s.name]));
}

function walk(root, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const next = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, next));
    else if (entry.isFile()) out.push(next);
  }
  return out.sort();
}

const underAny = (rel, prefixes) => prefixes.some((p) => rel === p || rel.startsWith(`${p}/`));

/** Every file the kit takes from upstream: kit-relative path → upstream file, plus the license. */
export function plannedCopies(manifest, vendorDir) {
  const copies = new Map();
  for (const skill of manifest.skills) {
    if (skill.origin === 'own') continue;
    const src = path.join(vendorDir, 'skills', skill.from);
    if (!fs.existsSync(src)) throw new Error(`kit.json: ${skill.name}: upstream skill "${skill.from}" not found in the vendor snapshot`);
    for (const rel of walk(src)) {
      if (underAny(rel, skill.drop ?? []) || underAny(rel, skill.own ?? [])) continue;
      copies.set(`skills/${skill.name}/${rel}`, path.join(src, rel));
    }
  }
  copies.set('LICENSE', path.join(vendorDir, 'LICENSE'));
  return copies;
}

export function ownedFiles(manifest) {
  const owned = [];
  for (const skill of manifest.skills) for (const rel of skill.own ?? (skill.origin === 'own' ? ['SKILL.md'] : [])) owned.push(`skills/${skill.name}/${rel}`);
  return owned;
}

function expectedContent(rel, from, names) {
  const raw = fs.readFileSync(from);
  return rel.endsWith('.md') ? Buffer.from(transform(raw.toString('utf8'), names)) : raw;
}

export function treeHash(dir) {
  const h = createHash('sha256');
  for (const f of walk(dir).filter((r) => r !== PIN_FILE)) {
    h.update(`${f}\0${createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex')}\n`);
  }
  return h.digest('hex');
}

export function renderUpstream(manifest) {
  const rows = manifest.skills.map((s) => {
    const origin = s.origin === 'own' ? 'own' : s.origin;
    const from = s.from ? `\`skills/${s.from}\`` : '—';
    return `| \`${s.name}\` | ${origin} | ${from} | ${(s.note ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`;
  });
  return [
    '# Provenance',
    '',
    `Generated from \`kit.json\` by \`npm run kit:build\` — edit the \`note\` there, not this file.`,
    '',
    `Devia Method ${manifest.version} started from an open-source skills library (MIT; the notice is in the repository's NOTICE file),`,
    `at its tag \`${manifest.upstream.tag}\` (\`${manifest.upstream.commit.slice(0, 7)}\`). \`LICENSE\` is that project's, unchanged.`,
    '',
    '- **literal** — copied from the pinned upstream; only the namespace prefix of a cross-reference is dropped.',
    '- **derived** — starts from an upstream skill; the files listed in `kit.json` as `own` are rewritten for Devia, the rest are copied.',
    '- **own** — written for Devia.',
    '',
    '`npm run kit:upstream-diff -- --tag <vX>` shows what changed upstream since this fork for every derived skill.',
    '',
    '| Skill | Origin | Upstream | What changes and why |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

export function buildKit(kitDir, vendorDir) {
  const manifest = readManifest(kitDir);
  const names = referencedNames(manifest);
  for (const [rel, from] of plannedCopies(manifest, vendorDir)) {
    const to = path.join(kitDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, expectedContent(rel, from, names), { mode: fs.statSync(from).mode & 0o777 });
  }
  fs.writeFileSync(path.join(kitDir, 'UPSTREAM.md'), renderUpstream(manifest));
  const problems = checkKit(kitDir, vendorDir, { skipPin: true });
  if (problems.length > 0) throw new Error(`kit is inconsistent after build:\n  ${problems.join('\n  ')}`);
  const pin = { tag: manifest.upstream.tag, commit: manifest.upstream.commit, sha256: treeHash(kitDir) };
  fs.writeFileSync(path.join(kitDir, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
  return pin;
}

/** Problems found, empty when the committed kit is exactly what a build produces. */
export function checkKit(kitDir, vendorDir, { skipPin = false } = {}) {
  const problems = [];
  const manifest = readManifest(kitDir);
  const vendorPin = JSON.parse(fs.readFileSync(path.join(vendorDir, PIN_FILE), 'utf8'));
  if (vendorPin.commit !== manifest.upstream.commit) {
    problems.push(`kit.json pins upstream ${manifest.upstream.commit.slice(0, 7)} but vendor/ is at ${vendorPin.commit.slice(0, 7)}`);
  }
  const copies = plannedCopies(manifest, vendorDir);
  const names = referencedNames(manifest);
  for (const [rel, from] of copies) {
    const file = path.join(kitDir, rel);
    if (!fs.existsSync(file)) problems.push(`missing copied file: ${rel}`);
    else if (!fs.readFileSync(file).equals(expectedContent(rel, from, names))) problems.push(`copied file edited by hand: ${rel} (it comes from upstream; own it in kit.json instead)`);
  }
  const owned = ownedFiles(manifest);
  for (const rel of owned) if (!fs.existsSync(path.join(kitDir, rel))) problems.push(`missing own file: ${rel}`);
  for (const skill of manifest.skills) if (!fs.existsSync(path.join(kitDir, 'skills', skill.name, 'SKILL.md'))) problems.push(`skill without SKILL.md: ${skill.name}`);
  const known = new Set([...copies.keys(), ...owned, ...KIT_LEVEL_FILES]);
  for (const rel of walk(kitDir)) if (!known.has(rel)) problems.push(`file not in kit.json (add it as own, or remove it): ${rel}`);
  if (fs.existsSync(path.join(kitDir, 'skills'))) {
    for (const d of fs.readdirSync(path.join(kitDir, 'skills'))) {
      if (!manifest.skills.some((s) => s.name === d)) problems.push(`skill directory not in kit.json: ${d}`);
    }
  }
  const upstreamMd = path.join(kitDir, 'UPSTREAM.md');
  if (!fs.existsSync(upstreamMd) || fs.readFileSync(upstreamMd, 'utf8') !== renderUpstream(manifest)) problems.push('UPSTREAM.md is stale (run npm run kit:build)');
  if (!skipPin) {
    try {
      const pin = JSON.parse(fs.readFileSync(path.join(kitDir, PIN_FILE), 'utf8'));
      if (pin.sha256 !== treeHash(kitDir)) problems.push('VERSION.json is stale (run npm run kit:build)');
    } catch {
      problems.push('VERSION.json missing or unreadable (run npm run kit:build)');
    }
  }
  return problems;
}

function main() {
  const root = path.resolve(import.meta.dirname, '..');
  const kitDir = path.join(root, 'resources', 'kits', 'devia-method');
  const vendorDir = path.join(root, 'vendor', 'upstream');
  if (process.argv.includes('--check')) {
    const problems = checkKit(kitDir, vendorDir);
    if (problems.length > 0) {
      console.error(`devia-method kit check failed:\n  ${problems.join('\n  ')}`);
      process.exit(1);
    }
    console.log('devia-method kit OK');
    return;
  }
  const pin = buildKit(kitDir, vendorDir);
  console.log(`built devia-method kit (upstream ${pin.tag} @ ${pin.commit.slice(0, 7)}, tree ${pin.sha256.slice(0, 12)})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
