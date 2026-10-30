// Stamps node_modules/ with the platform it was built for so that a later
// `nx run desktop:serve` from another OS (typical when bouncing between
// Windows and WSL on the same git working tree on different filesystems)
// fails fast with a clear message instead of crashing inside Electron's
// native binding with an opaque SIGSEGV.
//
// Runs as the second half of `postinstall`, after electron-rebuild has
// recompiled node-pty against the current Electron ABI.
//
// Dual-mode: works whether dependencies are installed under
// apps/desktop/node_modules (standalone) or hoisted to the monorepo
// root node_modules (npm workspaces).

const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function resolveModuleDir() {
  try {
    const pkg = require.resolve('node-pty/package.json', { paths: [root] });
    return path.dirname(path.dirname(path.dirname(pkg)));
  } catch {
    return root;
  }
}

function resolveElectronVersion() {
  try {
    const pkg = require.resolve('electron/package.json', { paths: [root] });
    return require(pkg).version;
  } catch {
    return 'unknown';
  }
}

const moduleDir = resolveModuleDir();
const markerPath = path.join(moduleDir, 'node_modules', '.devia-platform');
const electronVersion = resolveElectronVersion();
const marker = `${process.platform}-${process.arch}-electron-${electronVersion}\n`;

try {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true });
  fs.writeFileSync(markerPath, marker, 'utf8');
} catch (err) {
  console.error('[platform-marker] failed to write marker:', err.message);
  process.exit(1);
}
