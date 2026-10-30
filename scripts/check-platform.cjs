// Verifies node_modules/ matches the current OS/arch/Electron version.
// Runs as `predev` / `prestart`; the marker is written by
// write-platform-marker.cjs at the end of postinstall.
//
// Exits 1 with a clear remediation step when there's a mismatch, instead
// of letting Electron load a foreign-OS native binding and SIGSEGV.

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const markerPath = path.join(root, 'node_modules', '.devia-platform');

let electronVersion = 'unknown';
try {
  electronVersion = require(path.join(root, 'node_modules', 'electron', 'package.json')).version;
} catch { /* fall through — handled below */ }

const expected = `${process.platform}-${process.arch}-electron-${electronVersion}`;

const RED = '\x1b[31m';
const YEL = '\x1b[33m';
const DIM = '\x1b[2m';
const RST = '\x1b[0m';

function bail(reason) {
  console.error(`\n${RED}✖ node_modules platform mismatch${RST}`);
  console.error(`  ${reason}`);
  console.error(`  ${YEL}→ run:${RST}  npm run reset    ${DIM}(wipes node_modules and runs npm ci)${RST}`);
  console.error(`  ${DIM}(this check exists because mixing native bindings across OSes`);
  console.error(`   crashes Electron with SIGSEGV — see scripts/check-platform.cjs)${RST}\n`);
  process.exit(1);
}

let actual;
try {
  actual = fs.readFileSync(markerPath, 'utf8').trim();
} catch {
  bail(`no marker found — node_modules looks stale or was never installed here.`);
}

if (actual !== expected) {
  bail(`built for ${YEL}${actual}${RST}, but current is ${YEL}${expected}${RST}.`);
}
