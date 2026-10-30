import type {
  DetectedAgent,
  RuntimeAgentDef,
  RuntimeModelOption,
  RuntimeProviderType,
  RuntimeApplicability,
} from '../../domain/runtime-agent-def';
import { resolveAgentBin } from '../resolve-bin';
import { agentCapabilities, type CapabilityMap } from './capabilities';
import { probeAgentAuthStatus } from './auth-probe';
import { execAgentFile } from './exec-file';
import { resolveOnPath } from './path-resolver';
import { classifyDetectionError } from './classify-detection-error';

export interface DetectAgentOptions {
  /**
   * Per-agent env overrides the user has saved in Settings (allowlist
   * already enforced upstream). Merged on top of `process.env` for both
   * the version probe and the model listing.
   */
  envOverrides?: Record<string, string>;
}

interface ResolvedBin {
  bin: string;
  path: string;
}

function isErrnoCode(err: unknown): err is NodeJS.ErrnoException {
  return typeof err === 'object' && err !== null && 'code' in err;
}

function notInvocable(err: unknown): boolean {
  if (!isErrnoCode(err)) return false;
  const code = err.code;
  if (typeof code === 'string') {
    return code === 'ENOENT' || code === 'EACCES' || code === 'ENOTDIR';
  }
  if (typeof code === 'number') {
    return code === 126 || code === 127;
  }
  return false;
}

function resolveBin(def: RuntimeAgentDef): ResolvedBin | null {
  const candidates = [def.bin, ...(def.fallbackBins ?? [])];
  for (const bin of candidates) {
    const found = resolveOnPath(bin);
    if (found) return { bin, path: found };
  }
  return null;
}

async function probeVersion(
  resolved: ResolvedBin,
  def: RuntimeAgentDef,
  env: NodeJS.ProcessEnv,
): Promise<{ available: boolean; version: string | null }> {
  try {
    const { stdout } = await execAgentFile(resolved.path, def.versionArgs, {
      env,
      timeout: 3_000,
    });
    const version = stdout.trim().split('\n')[0] ?? null;
    return { available: true, version };
  } catch (err) {
    if (notInvocable(err)) return { available: false, version: null };
    // Some CLIs print to stderr and exit non-zero on `--version`. Treat
    // that as available-with-unknown-version rather than failed.
    return { available: true, version: null };
  }
}

async function probeCapabilities(
  resolved: ResolvedBin,
  def: RuntimeAgentDef,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  if (!def.helpArgs || !def.capabilityFlags) return;
  let help = '';
  try {
    const out = await execAgentFile(resolved.path, def.helpArgs, {
      env,
      timeout: 3_000,
    });
    help = `${out.stdout}\n${out.stderr}`;
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    help = `${e.stdout ?? ''}\n${e.stderr ?? ''}`;
  }
  const caps: CapabilityMap = {};
  for (const [flag, key] of Object.entries(def.capabilityFlags)) {
    caps[key] = help.includes(flag);
  }
  agentCapabilities.set(def.id, caps);
}

async function fetchModels(
  resolved: ResolvedBin,
  def: RuntimeAgentDef,
  env: NodeJS.ProcessEnv,
): Promise<RuntimeModelOption[]> {
  if (!def.listModels) return def.fallbackModels;
  try {
    const { stdout } = await execAgentFile(resolved.path, def.listModels.args, {
      env,
      timeout: def.listModels.timeoutMs ?? 5_000,
    });
    const parsed = def.listModels.parse(stdout);
    if (!parsed || parsed.length === 0) return def.fallbackModels;
    return parsed;
  } catch {
    return def.fallbackModels;
  }
}

function buildEnv(
  def: RuntimeAgentDef,
  overrides: Record<string, string> | undefined,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...(def.env ?? {}) };
  if (overrides) {
    const allowed = new Set(def.envOverrideKeys ?? []);
    for (const [key, value] of Object.entries(overrides)) {
      if (allowed.has(key) && typeof value === 'string' && value.length > 0) {
        env[key] = value;
      }
    }
  }
  return env;
}

function providerTypeOf(def: RuntimeAgentDef): RuntimeProviderType {
  return def.providerType ?? 'cli';
}

function applicabilityOf(def: RuntimeAgentDef): RuntimeApplicability {
  if (def.applicability) return def.applicability;
  // Default: built-in CLI adapters are fully direct; anything else is adapted
  // or planned (overridden explicitly by those defs).
  return providerTypeOf(def) === 'cli' ? 'direct' : 'planned';
}

/**
 * For non-CLI providers, decide whether the user has supplied the keys
 * required for the provider to be considered "configured". Never returns
 * the values themselves — only a boolean — so secrets never leave the
 * main process.
 */
function isConfigured(def: RuntimeAgentDef, env: NodeJS.ProcessEnv): boolean {
  const keys = def.requiredEnvKeys ?? [];
  if (keys.length === 0) return false;
  for (const key of keys) {
    const val = env[key];
    if (typeof val !== 'string' || val.length === 0) return false;
  }
  return true;
}

/**
 * Wraps a single agent detection so a thrown error never aborts the
 * parallel `detectAll` run for the rest of the catalog. The caller
 * receives a stub DetectedAgent marked unavailable with a sanitised
 * error message.
 */
export function detectAgentSafe(
  def: RuntimeAgentDef,
  options: DetectAgentOptions = {},
): Promise<DetectedAgent> {
  return detectAgent(def, options).catch((err: unknown) => {
    const { label, rawForLog } = classifyDetectionError(err);
    console.warn(`[detection:${def.id}] detection error (raw):`, rawForLog);
    const fallback: DetectedAgent = {
      id: def.id,
      name: def.name,
      bin: def.bin,
      streamFormat: def.streamFormat,
      models: def.fallbackModels,
      available: false,
      providerType: providerTypeOf(def),
      applicability: applicabilityOf(def),
      selectable: false,
      authStatus: 'unknown',
      unavailableReason: label,
    };
    return fallback;
  });
}

/**
 * Detect a single agent. Returns `available: false` when the binary
 * cannot be resolved or refuses to run — the UI uses that to render an
 * "install" link instead of letting the user pick it.
 *
 * Detection pipeline (TS-CLI-13):
 * 1. `resolveAgentBin` — locate the best binary path (handles Codex native
 *    binary on Windows) and collect any `diagnostic` string.
 * 2. `resolveBin` — PATH-visible resolution used for display (`path` field).
 * 3. `probeVersion` using the resolved binary (not `def.bin` directly).
 * 4. `probeCapabilities` and `fetchModels` using the resolved binary.
 * 5. `probeAgentAuthStatus` — auth check for supported agents (Claude only).
 */
export async function detectAgent(
  def: RuntimeAgentDef,
  options: DetectAgentOptions = {},
): Promise<DetectedAgent> {
  const env = buildEnv(def, options.envOverrides);
  const providerType = providerTypeOf(def);
  const applicability = applicabilityOf(def);

  // --- Non-CLI providers: skip binary probe entirely. ---------------------
  // API / MCP / local-model / planned providers cannot be detected via
  // PATH. We only report whether the user has supplied the keys they
  // declared in `requiredEnvKeys` (api, local-model) — no values are
  // returned, no external calls are made.
  if (providerType !== 'cli') {
    const configured =
      providerType === 'planned' ? false : isConfigured(def, env);
    const reason =
      def.unavailableReason ??
      (providerType === 'planned'
        ? 'Planned provider — execution support not implemented yet.'
        : `Execution support for ${providerType} providers is planned.`);
    const nonCli: DetectedAgent = {
      id: def.id,
      name: def.name,
      bin: def.bin,
      streamFormat: def.streamFormat,
      ...(def.envOverrideKeys ? { envOverrideKeys: def.envOverrideKeys } : {}),
      ...(def.installUrl ? { installUrl: def.installUrl } : {}),
      ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}),
      models: def.fallbackModels,
      available: false,
      providerType,
      applicability,
      configured,
      unavailableReason: reason,
      selectable: false,
      authStatus: 'unknown',
    };
    return nonCli;
  }

  // --- Step 1: resolve the best binary path and capture diagnostic -------
  const binResolution = resolveAgentBin(def, env);
  const probeTarget =
    binResolution.launchPath ?? binResolution.selectedPath ?? def.bin;

  const base: DetectedAgent = {
    id: def.id,
    name: def.name,
    bin: def.bin,
    streamFormat: def.streamFormat,
    ...(def.eventParser ? { eventParser: def.eventParser } : {}),
    ...(def.promptViaStdin ? { promptViaStdin: def.promptViaStdin } : {}),
    ...(def.promptInputFormat ? { promptInputFormat: def.promptInputFormat } : {}),
    ...(def.reasoningOptions ? { reasoningOptions: def.reasoningOptions } : {}),
    ...(def.envOverrideKeys ? { envOverrideKeys: def.envOverrideKeys } : {}),
    ...(def.installUrl ? { installUrl: def.installUrl } : {}),
    ...(def.docsUrl ? { docsUrl: def.docsUrl } : {}),
    models: def.fallbackModels,
    available: false,
    providerType,
    applicability,
    selectable: false,
    authStatus: 'unknown',
    resolvedBin: probeTarget,
    ...(binResolution.diagnostic ? { diagnostic: binResolution.diagnostic } : {}),
  };

  // --- Step 2: PATH-visible resolution (used for the display path) --------
  const resolved = resolveBin(def);

  // REV-TS-CLI-13-04: when `resolveBin` finds nothing on PATH but a native
  // binary was located by `resolveAgentBin` (e.g. Codex on Windows without
  // the npm shim on PATH), synthesise a ResolvedBin from the native path so
  // the detection pipeline continues.  We only skip when there is truly no
  // probe target at all.
  if (!resolved && binResolution.launchKind !== 'codex-native') {
    return {
      ...base,
      unavailableReason: `Binary "${def.bin}" not found on PATH.`,
    };
  }

  // The path we hand to `execFile`/`spawn` must be the *full resolved path*
  // (e.g. `C:\Users\<u>\AppData\Roaming\npm\codex.cmd`), not the bare bin
  // name. On Windows, `execFile("codex", ...)` only matches an exact file
  // named `codex` — it ignores PATHEXT — so probing with the bare name
  // fails for every npm-installed `.cmd` shim (codex, opencode, gemini,
  // qwen, deepseek, qoder, …). Codex on Windows is the one case where
  // `binResolution.launchPath` points at a native `.exe` that is not on
  // PATH; for everyone else we prefer `resolved.path`.
  const probeBin: ResolvedBin =
    binResolution.launchKind === 'codex-native'
      ? { bin: probeTarget, path: probeTarget }
      : resolved
        ? { bin: resolved.bin, path: resolved.path }
        : { bin: probeTarget, path: probeTarget };

  // The display path is the PATH-resolved path when available, else the probe target.
  const displayPath = resolved?.path ?? probeTarget;

  // --- Step 3: version probe ---------------------------------------------
  const { available, version } = await probeVersion(probeBin, def, env);
  if (!available) {
    return {
      ...base,
      path: displayPath,
      unavailableReason: `Binary "${def.bin}" found at ${displayPath} but did not respond to ${def.versionArgs.join(' ')}.`,
    };
  }

  // --- Step 4: capability and model probes --------------------------------
  await probeCapabilities(probeBin, def, env);
  const models = await fetchModels(probeBin, def, env);

  // --- Step 5: auth status probe -----------------------------------------
  // REV-AGENT-CORE-010: dispatcher now takes the def itself and calls
  // `def.authProbe` when present. Adapters without a probe → 'unknown'.
  // Hand it `probeBin.path` (full resolved path) so the probe spawns the
  // same target the version probe did — never the bare `def.bin` name,
  // which fails on Windows for `.cmd` shims.
  const authResult = await probeAgentAuthStatus(def, probeBin.path, env);

  return {
    ...base,
    available: true,
    selectable: true,
    path: displayPath,
    version,
    models,
    authStatus: authResult.status,
    ...(authResult.message ? { authMessage: authResult.message } : {}),
  };
}
