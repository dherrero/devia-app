import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolves a binary name on PATH plus the well-known toolchain dirs an
 * Electron app launched from the GUI doesn't normally inherit. Covers:
 *   - POSIX: Homebrew, `/usr/local`, the user's npm prefix, asdf/mise shims,
 *     nvm/fnm versioned binaries.
 *   - Windows: %APPDATA%\npm (default npm global), %LOCALAPPDATA%\pnpm,
 *     Yarn, scoop, chocolatey, WinGet links, GitHub CLI, and the Program
 *     Files Node install. All paths are derived from documented Windows
 *     environment variables — no user-specific absolute paths are hardcoded.
 *
 * Paths are appended to whatever `process.env.PATH` already contains; they
 * never override it.
 */

let cachedDirs: string[] | null = null;
let cachedAt = 0;
const TTL_MS = 5_000;

function homedirSafe(): string {
  try { return os.homedir(); } catch { return ''; }
}

function existsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function userToolchainDirs(): string[] {
  const home = homedirSafe();
  const out: string[] = [];
  const isWin = process.platform === 'win32';

  if (!isWin) {
    // POSIX system dirs
    out.push('/usr/local/bin', '/usr/local/sbin', '/opt/homebrew/bin', '/opt/homebrew/sbin');
  }

  if (home) {
    // Common per-user locations (POSIX + Windows-friendly)
    out.push(
      path.join(home, '.local', 'bin'),
      path.join(home, 'bin'),
      path.join(home, '.npm-global', 'bin'),
      path.join(home, '.bun', 'bin'),
      path.join(home, '.deno', 'bin'),
      path.join(home, '.cargo', 'bin'),
      // nvm — latest installed version is the user's intent in most cases.
      path.join(home, '.nvm', 'versions', 'node'),
      // fnm
      path.join(home, '.local', 'share', 'fnm', 'node-versions'),
      // asdf shims
      path.join(home, '.asdf', 'shims'),
      // mise
      path.join(home, '.local', 'share', 'mise', 'shims'),
    );
  }

  if (isWin) {
    // Common Windows install locations Electron's process.env.PATH
    // often misses when launched from a GUI shortcut. All safe, system-
    // standard paths — no user-machine-specific absolute paths.
    const APPDATA = process.env['APPDATA'];           // e.g. C:\Users\<u>\AppData\Roaming
    const LOCALAPPDATA = process.env['LOCALAPPDATA']; // e.g. C:\Users\<u>\AppData\Local
    const PROGRAMDATA = process.env['PROGRAMDATA'];   // e.g. C:\ProgramData
    const PROGRAMFILES = process.env['ProgramFiles'];
    const PROGRAMFILESX86 = process.env['ProgramFiles(x86)'];

    if (APPDATA) {
      out.push(path.join(APPDATA, 'npm'));            // npm global default on Windows
      out.push(path.join(APPDATA, 'npm-cache', 'bin'));
    }
    if (LOCALAPPDATA) {
      out.push(path.join(LOCALAPPDATA, 'pnpm'));
      out.push(path.join(LOCALAPPDATA, 'Yarn', 'bin'));
      out.push(path.join(LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'));
      out.push(path.join(LOCALAPPDATA, 'Programs', 'oh-my-posh', 'bin'));
    }
    if (home) {
      out.push(path.join(home, 'scoop', 'shims'));
      out.push(path.join(home, '.local', 'bin'));     // some Windows tools install here
    }
    if (PROGRAMDATA) {
      out.push(path.join(PROGRAMDATA, 'chocolatey', 'bin'));
      out.push(path.join(PROGRAMDATA, 'scoop', 'shims'));
    }
    if (PROGRAMFILES) {
      out.push(path.join(PROGRAMFILES, 'nodejs'));
      out.push(path.join(PROGRAMFILES, 'Git', 'cmd'));
      out.push(path.join(PROGRAMFILES, 'Git', 'bin'));
      out.push(path.join(PROGRAMFILES, 'GitHub CLI'));
    }
    if (PROGRAMFILESX86) {
      out.push(path.join(PROGRAMFILESX86, 'nodejs'));
    }
  }

  return out.filter((d) => d.length > 0);
}

function expandNvmDirs(dir: string): string[] {
  // nvm structure: <dir>/<version>/bin
  try {
    const versions = fs.readdirSync(dir);
    return versions
      .map((v) => path.join(dir, v, 'bin'))
      .filter(existsDir);
  } catch {
    return [];
  }
}

function resolvePathDirs(): string[] {
  const now = Date.now();
  if (cachedDirs && now - cachedAt < TTL_MS) return cachedDirs;

  const dirs = new Set<string>();
  const pathEnv = process.env['PATH'] ?? '';
  const sep = process.platform === 'win32' ? ';' : ':';
  for (const d of pathEnv.split(sep)) {
    if (d) dirs.add(d);
  }
  for (const d of userToolchainDirs()) {
    if (d.endsWith('node-versions') || d.endsWith(path.join('versions', 'node'))) {
      for (const expanded of expandNvmDirs(d)) dirs.add(expanded);
    } else if (existsDir(d)) {
      dirs.add(d);
    }
  }

  cachedDirs = Array.from(dirs);
  cachedAt = now;
  return cachedDirs;
}

/**
 * Search every PATH-like directory for `bin` (plus PATHEXT on Windows).
 * Returns the first hit or null.
 */
export function resolveOnPath(bin: string): string | null {
  const exts =
    process.platform === 'win32'
      ? (process.env['PATHEXT'] ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  for (const dir of resolvePathDirs()) {
    for (const ext of exts) {
      const full = path.join(dir, bin + ext);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        // ignore traversal errors
      }
    }
  }
  return null;
}

export function clearPathResolverCache(): void {
  cachedDirs = null;
  cachedAt = 0;
}

/**
 * Exported for tests: returns the full list of directories the resolver
 * will search for a given binary. Useful for verifying Windows-specific
 * locations (`%APPDATA%\npm`, scoop shims, …) without spying on `fs`.
 *
 * Always clears the cache so each call reflects the current `process.env`
 * and `process.platform`. Not part of the public API — runtime callers
 * should always go through `resolveOnPath`.
 */
export function debugListResolvedDirs(): string[] {
  clearPathResolverCache();
  return resolvePathDirs();
}
