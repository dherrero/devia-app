// Prepares the node-pty native binding for the current Electron ABI.
//
// Resolves node-pty from the repository's node_modules, wherever npm placed it.
//
// Strategy:
//  1. Try electron-rebuild against the resolved module dir (compiles a
//     binding matching the exact Electron ABI in use — preferred).
//  2. If electron-rebuild fails (typical on Windows boxes missing the C++
//     toolchain / Python / `cmd` resolution), fall back to copying the
//     NAPI prebuild that ships inside `node-pty/prebuilds/<plat>-<arch>/`
//     into `build/Release/`. NAPI bindings are ABI-stable across Node and
//     Electron versions, so this is a valid fallback for runtime.
//  3. Only if no prebuild exists for the current platform do we surface
//     the original error and exit non-zero.

const { execSync } = require('node:child_process');
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

function resolveNodePtyDir() {
  try {
    const pkg = require.resolve('node-pty/package.json', { paths: [root] });
    return path.dirname(pkg);
  } catch {
    return null;
  }
}

function tryElectronRebuild(moduleDir) {
  try {
    execSync(`electron-rebuild -f -w node-pty --module-dir "${moduleDir}"`, {
      stdio: 'inherit',
      cwd: root,
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

function copyPrebuild(nodePtyDir) {
  const platDir = path.join(nodePtyDir, 'prebuilds', `${process.platform}-${process.arch}`);
  if (!fs.existsSync(platDir)) {
    return { ok: false, reason: `no prebuild at ${platDir}` };
  }
  const releaseDir = path.join(nodePtyDir, 'build', 'Release');
  fs.mkdirSync(releaseDir, { recursive: true });

  const copyIfPresent = (name) => {
    const src = path.join(platDir, name);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(releaseDir, name));
      return true;
    }
    return false;
  };

  const copied = ['pty.node', 'conpty.node', 'conpty_console_list.node'].filter(copyIfPresent);
  if (copied.length === 0) {
    return { ok: false, reason: `prebuild dir present but no .node files copied` };
  }

  if (process.platform === 'win32') {
    const dllSrc = path.join(platDir, 'winpty.dll');
    const dllDst = path.join(releaseDir, 'winpty.dll');
    if (fs.existsSync(dllSrc)) fs.copyFileSync(dllSrc, dllDst);
    const agentSrc = path.join(platDir, 'winpty-agent.exe');
    const agentDst = path.join(releaseDir, 'winpty-agent.exe');
    if (fs.existsSync(agentSrc)) fs.copyFileSync(agentSrc, agentDst);
    const conptySubdir = path.join(platDir, 'conpty');
    if (fs.existsSync(conptySubdir)) {
      const dstConpty = path.join(releaseDir, 'conpty');
      fs.mkdirSync(dstConpty, { recursive: true });
      for (const f of fs.readdirSync(conptySubdir)) {
        fs.copyFileSync(path.join(conptySubdir, f), path.join(dstConpty, f));
      }
    }
  }

  return { ok: true, copied };
}

const moduleDir = resolveModuleDir();
const nodePtyDir = resolveNodePtyDir();

const rebuilt = tryElectronRebuild(moduleDir);
if (rebuilt.ok) {
  process.exit(0);
}

console.warn('\n[rebuild-native] electron-rebuild failed — falling back to shipped NAPI prebuild.');
console.warn(`[rebuild-native] (root cause: ${rebuilt.err && rebuilt.err.message ? rebuilt.err.message.split('\n')[0] : 'unknown'})`);

if (!nodePtyDir) {
  console.error('[rebuild-native] cannot locate node-pty directory — aborting.');
  process.exit(1);
}

const fallback = copyPrebuild(nodePtyDir);
if (!fallback.ok) {
  console.error(`[rebuild-native] no usable prebuild: ${fallback.reason}`);
  console.error('[rebuild-native] install the native toolchain (Windows: VS Build Tools + Python) and re-run "npm install".');
  process.exit(1);
}

console.warn(`[rebuild-native] installed NAPI prebuild for ${process.platform}-${process.arch}: ${fallback.copied.join(', ')}`);
console.warn('[rebuild-native] runtime is OK. To recompile against your exact Electron ABI, fix the native toolchain and re-run "npm install".');
process.exit(0);
