import { existsSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

/**
 * Resolution outcome for an agent binary.
 */
export interface AgentBinResolution {
  /** First binary found on PATH (or `def.bin` when resolution is skipped). */
  selectedPath: string | null;
  /** Actual path handed to `spawn`. May differ from `selectedPath` for Codex. */
  launchPath: string | null;
  /** Indicates whether the native binary or the npm-shim wrapper was chosen. */
  launchKind: 'selected' | 'codex-native';
  /** Directories prepended to the child's PATH when native resolution succeeds. */
  childPathPrepend: string[];
  /** Human-readable note surfaced when fallback behaviour is triggered. */
  diagnostic: string | null;
}

/**
 * Candidate sub-paths within the `@openai/codex-win32-*` packages that may
 * contain the native Codex binary, newest packaging first: current releases
 * ship `vendor/<triple>/bin/codex.exe` (with `codex-resources/` siblings for
 * the Windows sandbox helpers); older ones used `vendor/<triple>/codex/` or
 * a flat layout.
 */
const CODEX_NATIVE_CANDIDATES = [
  join('vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
  join('vendor', 'aarch64-pc-windows-msvc', 'bin', 'codex.exe'),
  join('vendor', 'x86_64-pc-windows-gnu', 'bin', 'codex.exe'),
  join('vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
  join('vendor', 'x86_64-pc-windows-gnu', 'codex', 'codex.exe'),
  join('codex.exe'),
];

/** Native sub-package names by architecture (x64 first — the common case). */
const CODEX_NATIVE_PKGS = ['codex-win32-x64', 'codex-win32-arm64'];

/** Probe one package root for the known vendor layouts. */
function probeCodexPkgRoot(pkgRoot: string): string | null {
  for (const candidate of CODEX_NATIVE_CANDIDATES) {
    const fullPath = join(pkgRoot, candidate);
    if (existsSync(fullPath)) return fullPath;
  }
  return null;
}

/**
 * Attempt to locate the native Codex binary. Resolution order:
 *
 *  1. `require.resolve` of the optional sub-package or `@openai/codex` from
 *     Devia's own module tree (app-local installs).
 *  2. The GLOBAL npm install: `npm i -g @openai/codex` puts the package under
 *     `<node-dir>/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64`,
 *     which `require.resolve` can NEVER see from Devia's tree — so we walk the
 *     PATH entries that carry a `codex` shim and probe their `node_modules`.
 *
 * Returns the absolute path of the first match, or `null`. Never throws.
 */
function findCodexNativeBinary(env: NodeJS.ProcessEnv): string | null {
  // 1) App-local resolution through the module tree.
  for (const pkg of CODEX_NATIVE_PKGS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pkgRoot = dirname(require.resolve(`@openai/${pkg}/package.json`));
      const hit = probeCodexPkgRoot(pkgRoot);
      if (hit) return hit;
    } catch {
      /* package not in our tree — keep looking */
    }
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const codexRoot = dirname(require.resolve('@openai/codex/package.json'));
    for (const pkg of CODEX_NATIVE_PKGS) {
      const hit = probeCodexPkgRoot(join(codexRoot, 'node_modules', '@openai', pkg));
      if (hit) return hit;
    }
  } catch {
    /* not in our tree either */
  }

  // 2) Global npm install: find the PATH dir holding the codex shim and probe
  //    its node_modules (both the nested and the hoisted layout).
  const pathVar = env['PATH'] ?? env['Path'] ?? '';
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    try {
      const hasShim = ['codex.cmd', 'codex.ps1', 'codex'].some((shim) =>
        existsSync(join(dir, shim)),
      );
      if (!hasShim) continue;
      for (const pkg of CODEX_NATIVE_PKGS) {
        const nested = probeCodexPkgRoot(
          join(dir, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', pkg),
        );
        if (nested) return nested;
        const hoisted = probeCodexPkgRoot(join(dir, 'node_modules', '@openai', pkg));
        if (hoisted) return hoisted;
      }
    } catch {
      /* unreadable PATH entry — skip */
    }
  }

  return null;
}

/**
 * Resolve the binary path and launch configuration for an agent.
 *
 * For most agents: `selectedPath = def.bin`, `launchPath = def.bin`,
 * `launchKind = 'selected'`.
 *
 * For Codex on Windows: walks `node_modules/@openai/codex-win32-x64/vendor/`
 * to find the native binary. When found, sets `launchKind = 'codex-native'`
 * and prepends the binary's directory to `childPathPrepend` so nested tool
 * invocations also resolve correctly.
 *
 * This function never throws. All file system operations are wrapped in
 * try/catch; on unexpected errors it returns a safe fallback that uses
 * `def.bin` directly.
 */
export function resolveAgentBin(
  def: RuntimeAgentDef,
  env: NodeJS.ProcessEnv,
): AgentBinResolution {
  try {
    const defaultResult: AgentBinResolution = {
      selectedPath: def.bin,
      launchPath: def.bin,
      launchKind: 'selected',
      childPathPrepend: [],
      diagnostic: null,
    };

    if (def.id !== 'codex' || process.platform !== 'win32') {
      return defaultResult;
    }

    // Codex on Windows — attempt native binary resolution.
    const nativePath = findCodexNativeBinary(env);

    if (nativePath === null) {
      return {
        ...defaultResult,
        diagnostic:
          'Codex native binary not found; falling back to shim. ' +
          'Install @openai/codex-win32-x64 or ensure "codex" is on PATH.',
      };
    }

    const nativeDir = dirname(nativePath);

    return {
      selectedPath: def.bin,
      launchPath: nativePath,
      launchKind: 'codex-native',
      childPathPrepend: [nativeDir],
      diagnostic: null,
    };
  } catch {
    // Safety net: never crash the launcher.
    return {
      selectedPath: null,
      launchPath: null,
      launchKind: 'selected',
      childPathPrepend: [],
      diagnostic: 'resolveAgentBin encountered an unexpected error; using def.bin.',
    };
  }
}
