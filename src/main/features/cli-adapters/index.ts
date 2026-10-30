import type { AgentHarnessView } from '../../../shared/domain/agent';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Feature, FeatureContext } from '../../shared/feature';
import type { ConfigRepository } from '../../shared/ports';

import { StaticCliAdapterRegistry } from './infrastructure/registry';
import { ParallelAgentDetector } from './infrastructure/detection/agent-detector';
import { ChildProcessCliLauncher } from './infrastructure/cli-launcher';

import { ListAgentsUseCase } from './application/list-agents.use-case';
import { SelectAgentUseCase } from './application/select-agent.use-case';
import { SetAgentModelUseCase } from './application/set-agent-model.use-case';
import { SetAgentEnvUseCase } from './application/set-agent-env.use-case';
import { TestAgentUseCase } from './application/test-agent.use-case';

import { registerCliAdaptersIpc, toView } from './ipc/cli-adapters.ipc';
import type { RuntimeAgentDef } from './domain/runtime-agent-def';

export { AGENT_DEFS, DEFAULT_AGENT_ID, StaticCliAdapterRegistry } from './infrastructure/registry';
export type { CliAdapterRegistry, AgentDetector } from './domain/ports';
export type {
  RuntimeAgentDef,
  RuntimeBuildOptions,
  DetectedAgent,
} from './domain/runtime-agent-def';
export { ChildProcessCliLauncher } from './infrastructure/cli-launcher';
export type { CliLauncher, CliRunRequest, CliProcessHandle } from './infrastructure/cli-launcher';

export interface CliAdaptersDeps {
  config: ConfigRepository;
  /**
   * S-30 contract A: what each agent can receive of Devia's harness, from its
   * mapper — so the renderer never hardcodes per-agent capability lists.
   */
  describeHarness?: (def: RuntimeAgentDef) => AgentHarnessView | undefined;
  /** S-2 F2.3: fired after a successful agent switch (handoff precompute). */
  onAgentSelected?: (agentId: string) => void;
}

export interface CliAdaptersExports {
  readonly registry: StaticCliAdapterRegistry;
  readonly detector: ParallelAgentDetector;
  readonly launcher: ChildProcessCliLauncher;
}

export interface CliAdaptersBuilt {
  readonly feature: Feature;
  readonly exports: CliAdaptersExports;
}

/** File name for user-supplied agent extensions in the Devia config directory. */
const AGENT_DEFS_FILENAME = 'agent-defs.json';

/**
 * Safe allowlist pattern for `envOverrideKeys` in user-supplied defs.
 *
 * Rationale: built-in defs restrict env override keys to agent-specific
 * credentials (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.). User-supplied
 * defs must follow the same constraint. Allowing arbitrary keys (e.g. `PATH`,
 * `HOME`, `LD_PRELOAD`) would let a malicious `agent-defs.json` redirect every
 * subprocess spawned by Devia or inject shared libraries.
 *
 * Accepted pattern: uppercase alphanumeric + underscore suffix matching one of
 * _API_KEY, _BASE_URL, _CONFIG_DIR, or _TOKEN.
 */
const SAFE_ENV_KEY_PATTERN = /^[A-Z0-9_]+((_API_KEY)|(_BASE_URL)|(_CONFIG_DIR)|(_TOKEN))$/;

/**
 * Validates and normalises a parsed JSON value into a minimal `RuntimeAgentDef`.
 *
 * Only `id` (string) and `bin` (string) are mandatory — the story calls for a
 * "loose check". Fields required by the detection layer (`versionArgs`,
 * `fallbackModels`, `streamFormat`, `name`) are given safe defaults when
 * absent, so the detection layer never crashes on a user-supplied def.
 *
 * Security: `env` and `envOverrideKeys` from user-supplied defs are sanitised:
 * - `env` is stripped entirely (static env injection from JSON is not supported).
 * - `envOverrideKeys` is filtered to keys matching `SAFE_ENV_KEY_PATTERN`.
 *
 * Returns `null` when mandatory fields are missing or not the right type.
 *
 * Exported for unit testing only — internal use via `buildCliAdaptersFeature`.
 */
export function normaliseUserDef(value: unknown): RuntimeAgentDef | null {
  if (typeof value !== 'object' || value === null) return null;
  const obj = value as Record<string, unknown>;

  const id = obj['id'];
  const bin = obj['bin'];
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof bin !== 'string' || bin.length === 0) return null;

  // Reject absolute paths — user-supplied bins must resolve on PATH.
  const isSuspectPath =
    bin.includes('/') ||
    bin.includes('\\') ||
    /^[a-zA-Z]:/.test(bin);  // Windows drive letter

  if (isSuspectPath) {
    console.warn(
      `[cli-adapters] user-supplied def "${id}": bin "${bin}" looks like an absolute path — ` +
      `only PATH-resolvable names are allowed. Skipping.`,
    );
    return null;
  }

  // Fields required by the detection layer — fill safe defaults.
  const name   = typeof obj['name'] === 'string' && obj['name'].length > 0 ? obj['name'] : id;
  const versionArgs: string[] = Array.isArray(obj['versionArgs'])
    ? (obj['versionArgs'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : ['--version'];
  const fallbackModels = Array.isArray(obj['fallbackModels'])
    ? (obj['fallbackModels'] as RuntimeAgentDef['fallbackModels'])
    : [];
  const streamFormat: RuntimeAgentDef['streamFormat'] =
    obj['streamFormat'] === 'plain' || obj['streamFormat'] === 'claude-stream-json' || obj['streamFormat'] === 'json-event-stream'
      ? obj['streamFormat']
      : 'plain';

  // `buildArgs` is required by the TypeScript interface but user-supplied defs
  // loaded from JSON obviously cannot provide a function. Provide a no-op
  // default so the launcher can safely call it; the launcher will also guard
  // against unavailable agents.
  const buildArgs = typeof obj['buildArgs'] === 'function'
    ? (obj['buildArgs'] as RuntimeAgentDef['buildArgs'])
    : () => [];

  // ── Security: sanitise env-related fields ────────────────────────────────
  // Strip the `env` field entirely — static env injection from JSON is not a
  // supported feature. Users needing env injection should use a wrapper script.
  if ('env' in obj && obj['env'] !== undefined) {
    console.warn(
      `[cli-adapters] user-supplied def "${id}": "env" field is not allowed in user-supplied ` +
      `defs and will be ignored. Use a wrapper script to set environment variables.`,
    );
  }

  // Filter `envOverrideKeys` to safe keys only — reject anything that could
  // allow the renderer to override PATH, HOME, LD_PRELOAD, etc.
  const rawEnvOverrideKeys = Array.isArray(obj['envOverrideKeys'])
    ? (obj['envOverrideKeys'] as unknown[]).filter(
        (k): k is string => typeof k === 'string' && SAFE_ENV_KEY_PATTERN.test(k),
      )
    : undefined;

  if (Array.isArray(obj['envOverrideKeys'])) {
    const rejected = (obj['envOverrideKeys'] as unknown[]).filter(
      (k) => typeof k !== 'string' || !SAFE_ENV_KEY_PATTERN.test(k as string),
    );
    if (rejected.length > 0) {
      console.warn(
        `[cli-adapters] user-supplied def "${id}": envOverrideKeys contains unsafe keys ` +
        `that were stripped: ${JSON.stringify(rejected)}. Only *_API_KEY, *_BASE_URL, ` +
        `*_CONFIG_DIR, *_TOKEN keys are allowed.`,
      );
    }
  }

  // Build the final def without spreading `obj` for env-sensitive fields.
  // Non-env/envOverrideKeys fields from `obj` are forwarded via the spread so
  // future extension fields remain compatible; env-sensitive fields are always
  // explicitly set to the sanitised values below.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { env: _env, envOverrideKeys: _envOverrideKeys, ...safeObjRest } = obj as Record<string, unknown> & { env?: unknown; envOverrideKeys?: unknown };

  return {
    // UC-FIX-018: default to 'unsupported' for user-supplied defs that omit
    // the field (JSON cannot supply a function, and old defs predate the field).
    systemPromptStrategy: 'unsupported' as const,
    ...(safeObjRest as Partial<RuntimeAgentDef>),
    id,
    bin,
    name,
    versionArgs,
    fallbackModels,
    streamFormat,
    buildArgs,
    // env is intentionally omitted — stripped from user-supplied defs.
    ...(rawEnvOverrideKeys !== undefined ? { envOverrideKeys: rawEnvOverrideKeys } : {}),
  };
}

/**
 * Synchronously loads user-supplied agent definitions from `agent-defs.json`
 * in the Devia config directory and registers them into the registry.
 *
 * This is intentionally synchronous: the file is small, local, and only read
 * once at startup in the Electron main process where a synchronous read is
 * acceptable. Loading it synchronously ensures `registry.all()` is fully
 * populated before the first `agents:list` IPC call (REV-TS-CLI-03-03).
 */
function loadUserAgentDefs(
  registry: StaticCliAdapterRegistry,
  configDir: string,
): void {
  const agentDefsPath = path.join(configDir, AGENT_DEFS_FILENAME);

  if (!fs.existsSync(agentDefsPath)) return;

  try {
    const raw: unknown = JSON.parse(fs.readFileSync(agentDefsPath, 'utf8'));

    if (!Array.isArray(raw)) {
      console.warn(
        `[cli-adapters] ${AGENT_DEFS_FILENAME} root must be an array — skipping`,
      );
      return;
    }

    const valid: RuntimeAgentDef[] = [];
    for (const entry of raw as unknown[]) {
      const normalised = normaliseUserDef(entry);
      if (normalised !== null) {
        valid.push(normalised);
      } else {
        console.warn(
          '[cli-adapters] skipping invalid entry in agent-defs.json (missing id or bin):',
          entry,
        );
      }
    }

    if (valid.length > 0) {
      registry.registerAdditional(valid);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      `[cli-adapters] failed to parse ${AGENT_DEFS_FILENAME}, using built-in defs only:`,
      message,
    );
  }
}

/**
 * Builds the cli-adapters feature plus the shared singletons every
 * downstream caller (claude-runner, future status badges) needs. The
 * registry + detector + launcher are exported on `built.exports` so the
 * composition root can wire them into other features without resolving
 * them through DI a second time.
 *
 * User-supplied `agent-defs.json` is loaded synchronously here so that
 * `registry.all()` is fully populated before the first `agents:list` IPC
 * call fires (REV-TS-CLI-03-03 — `onReady` timing race).
 */
export function buildCliAdaptersFeature(deps: CliAdaptersDeps): CliAdaptersBuilt {
  const registry = new StaticCliAdapterRegistry();

  // Load user-supplied defs eagerly (synchronous) so the registry is complete
  // before IPC handlers are registered and the renderer can call agents:list.
  loadUserAgentDefs(registry, deps.config.deviaDir());

  const detector = new ParallelAgentDetector({
    registry,
    getEnvOverrides: (agentId: string) => deps.config.get().agentCliEnv[agentId] ?? {},
  });
  const launcher = new ChildProcessCliLauncher();

  const listAgents    = new ListAgentsUseCase(detector);
  const selectAgent   = new SelectAgentUseCase(registry, deps.config, deps.onAgentSelected);
  const setAgentModel = new SetAgentModelUseCase(registry, deps.config);
  const setAgentEnv   = new SetAgentEnvUseCase(registry, deps.config);
  const testAgent     = new TestAgentUseCase(detector);

  const describe = (agentId: string): AgentHarnessView | undefined => {
    const def = registry.get(agentId);
    return def && (def.providerType ?? 'cli') === 'cli' ? deps.describeHarness?.(def) : undefined;
  };

  const feature: Feature = {
    id: 'cli-adapters',
    register(ctx: FeatureContext) {
      registerCliAdaptersIpc(ctx, {
        listAgents, selectAgent, setAgentModel, setAgentEnv, testAgent, describe,
        onAgentSelected: () => detector.invalidateCache(),
      });
    },

    async onReady(ctx: FeatureContext): Promise<void> {
      // Validate config.agentId against known agents now that the registry is
      // fully populated. Falls back to the first CLI-type agent if the stored
      // id is stale, was removed, or points at a non-executable provider
      // (api/mcp/local-model/planned).
      const config = deps.config.get();
      const current = registry.get(config.agentId);
      const isExecutable = current && (current.providerType ?? 'cli') === 'cli';

      if (!isExecutable) {
        const cliDef = registry.all().find((d) => (d.providerType ?? 'cli') === 'cli');
        const fallbackId = cliDef?.id ?? 'claude';
        console.warn(
          `[cli-adapters] config.agentId "${config.agentId}" is not a selectable CLI agent; ` +
          `falling back to "${fallbackId}"`,
        );
        deps.config.set({ agentId: fallbackId });
      }

      // Pre-warm the detection cache at startup and push results to the renderer
      // so the splash screen can release without a separate agents:list IPC call.
      try {
        const detected = await detector.detectAll();
        ctx.send('agents:detected', { agents: detected.map((a) => toView(a, describe(a.id))) });
      } catch {
        ctx.send('agents:detected', { agents: [] });
      }
    },
  };

  return { feature, exports: { registry, detector, launcher } };
}
