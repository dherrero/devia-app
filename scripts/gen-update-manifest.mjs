#!/usr/bin/env node
// Regenerates the public website update manifest (updates/latest.json) from a
// published GitHub Release's asset list. This manifest is consumed ONLY by the
// download landing page (assets/js/main.js): version, notes and per-platform
// download URLs. The integrity feed the desktop app actually verifies against
// is electron-updater's latest*.yml (also attached to the same Release), NOT
// this file — so sha512 here is best-effort/optional.
//
// Usage:
//   node scripts/gen-update-manifest.mjs \
//     --release-json release.json \   # output of: gh release view <tag> --json assets,body
//     --tag v0.26.0 --version 0.26.0 \
//     --out <public-repo>/updates/latest.json \
//     [--notes "free text"]
//
// Asset filename → platform key:
//   *.exe                → win32-x64
//   *arm64*.dmg          → darwin-arm64
//   *.dmg (no arm64)     → darwin-x64
//   *.AppImage           → linux-x64-appimage
//   *.deb                → linux-x64-deb
// (.zip / .yml / .blockmap are ignored — zip is the mac auto-update payload,
//  not a user download.)

import { readFileSync, writeFileSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const releaseJsonPath = arg('release-json');
const tag = arg('tag');
const version = arg('version') || (tag || '').replace(/^v/, '');
const outPath = arg('out');
const notesArg = arg('notes');

if (!releaseJsonPath || !tag || !outPath) {
  console.error('Missing required args: --release-json, --tag, --out');
  process.exit(1);
}

const release = JSON.parse(readFileSync(releaseJsonPath, 'utf8'));
const assets = Array.isArray(release.assets) ? release.assets : [];

function platformKey(name) {
  const n = name.toLowerCase();
  if (n.endsWith('.exe')) return 'win32-x64';
  if (n.endsWith('.dmg')) return /arm64/.test(n) ? 'darwin-arm64' : 'darwin-x64';
  if (n.endsWith('.appimage')) return 'linux-x64-appimage';
  if (n.endsWith('.deb')) return 'linux-x64-deb';
  return null;
}

function downloadUrl(asset) {
  // gh's asset.url is the browser download URL; fall back to the stable form.
  if (asset.url && /\/releases\/download\//.test(asset.url)) return asset.url;
  return `https://github.com/dherrero/devia/releases/download/${tag}/${encodeURIComponent(asset.name)}`;
}

const platforms = {
  'win32-x64': { url: '', sha512: '', size: 0 },
  'darwin-x64': { url: '', sha512: '', size: 0 },
  'darwin-arm64': { url: '', sha512: '', size: 0 },
  'linux-x64-appimage': { url: '', sha512: '', size: 0 },
  'linux-x64-deb': { url: '', sha512: '', size: 0 },
};

let resolved = 0;
for (const asset of assets) {
  const key = platformKey(asset.name);
  if (!key) continue;
  platforms[key] = { url: downloadUrl(asset), sha512: '', size: asset.size || 0 };
  resolved++;
}

// Blindaje: si la Release no tiene NINGÚN instalador (build totalmente fallido o
// Release inexistente), no escribimos nada. Así un release parcial nunca pisa el
// latest.json bueno con URLs vacías; la web conserva los enlaces de la versión
// anterior en lugar de quedarse en "Próximamente".
if (resolved === 0) {
  console.warn(`No installer assets found for ${tag} — leaving ${outPath} untouched.`);
  process.exit(0);
}

const manifest = {
  product: 'Devia',
  channel: 'stable',
  version,
  pubDate: new Date().toISOString(),
  notes:
    notesArg ||
    (typeof release.body === 'string' && release.body.trim()
      ? release.body.trim().split('\n')[0]
      : `Devia Desktop v${version}`),
  notesUrl: 'https://dherrero.github.io/devia/descargas/',
  platforms,
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`Wrote ${outPath} for v${version}:`);
for (const [k, v] of Object.entries(platforms)) {
  console.log(`  ${k.padEnd(20)} ${v.url ? `${(v.size / 1048576).toFixed(0)} MB` : '(missing)'}`);
}
