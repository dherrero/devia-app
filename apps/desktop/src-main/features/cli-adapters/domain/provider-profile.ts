import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type { ClassifiedError } from '../../../../shared/domain/cli-errors';
import type {
  RuntimeAgentDef,
  RuntimeBuildOptions,
  RuntimeContext,
  RuntimeStreamFormat,
} from './runtime-agent-def';

/**
 * Hermes-inspired provider abstraction (E-DSK-09 #264).
 *
 * Today devia's CLI catalog lives in {@link RuntimeAgentDef}, which
 * carries every detail the launcher / detection layers need to drive an
 * agent. `RuntimeAgentDef` grew organically across many tickets and ended
 * up as a 30-field record with optional hooks scattered across the
 * codebase (stream parser selection is in the launcher, error
 * classification is in the runner, etc.).
 *
 * `ProviderProfile` is a thinner, recovery-oriented *view* of the same
 * data:
 *   - Every spawn / detection / streaming concern collapses to a small
 *     set of hooks the runner consumes generically.
 *   - Error classification ({@link classifyError}) plugs into the new
 *     `FailoverReason` taxonomy from #262, so the runner stops having
 *     special-case logic per CLI.
 *   - Stream parsing ({@link parseStreamLine}) wraps the existing
 *     per-format parser registry so the runner becomes parser-agnostic.
 *
 * The interface is intentionally a *superset* of what the runner needs
 * today; the underlying `RuntimeAgentDef` is preserved for the
 * detection / settings layers that still want the verbose shape. Both
 * surfaces are derived from the same source data via
 * `toProviderProfile()`.
 */
export interface ProviderProfile {
  /** Stable id reused as the registry key. */
  readonly id: string;
  /** Human-readable name surfaced in the Settings picker. */
  readonly displayName: string;
  /** How the binary is located on the user's system. */
  readonly binResolution: BinResolution;
  /** What kind of credential the user must provide. */
  readonly authType: AuthType;
  /** Documented env vars consumed by the provider — for the Settings UI. */
  readonly envVars: ReadonlyArray<EnvVarDeclaration>;
  /** Where the system prompt is injected. Matches RuntimeAgentDef. */
  readonly systemPromptStrategy: 'argv' | 'stdin-prepend' | 'argv-prepend' | 'argv-file' | 'unsupported';
  /** Stream format the agent emits. Matches RuntimeAgentDef. */
  readonly streamFormat: RuntimeStreamFormat;
  /** Per-profile capability declarations consumed by the renderer to
   *  enable / grey out controls. */
  readonly supportedFeatures: SupportedFeatures;

  /** Build the launcher argv for a single spawn. */
  buildArgv(ctx: SpawnContext): string[];
  /** Build the env merge the launcher applies on top of the inherited
   *  environment. */
  buildEnv(ctx: SpawnContext): Record<string, string>;
  /** Translate one stream line into 0..N {@link AgentEvent} values.
   *  `state` is the per-run parser state; the implementation owns its
   *  shape (line buffer, frame buffer, …). */
  parseStreamLine(line: string, state: ParserState): AgentEvent[];
  /** Classify a stderr / error event into a {@link ClassifiedError}.
   *  Wraps the unified `classify(cliId, raw)` from #262 and lets a
   *  profile override per-CLI overrides if needed. */
  classifyError(stderr: string): ClassifiedError;
}

export type BinResolution =
  | { readonly kind: 'argv-list'; readonly candidates: readonly string[] }
  | { readonly kind: 'env-path'; readonly envVar: string };

export type AuthType =
  | 'none'
  | 'api-key-env'
  | 'oauth-cli'
  | 'session-file';

export interface EnvVarDeclaration {
  readonly name: string;
  readonly required: boolean;
  readonly description: string;
}

export interface SupportedFeatures {
  readonly thinking: boolean;
  readonly toolUse: boolean;
  readonly mcp: boolean;
  readonly cancellation: boolean;
  readonly multimodal: boolean;
}

export interface SpawnContext {
  /** User prompt after attachment augmentation. */
  readonly prompt: string;
  /** Working directory the launcher will `spawn(..., { cwd })` with. */
  readonly cwd: string;
  /** Validated workspace-relative image paths (multimodal agents). */
  readonly imagePaths: ReadonlyArray<string>;
  /** Extra workspace dirs the agent may read. */
  readonly extraAllowedDirs?: ReadonlyArray<string>;
  /** Model / reasoning hints from the user's Settings. */
  readonly options?: RuntimeBuildOptions;
  /** Runtime hints (e.g. detected CWD overrides). */
  readonly runtimeContext?: RuntimeContext;
  /** Effective environment to inject (defaults to `process.env`). */
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Per-run parser state held by `parseStreamLine` implementations.
 * Opaque to the runner — each format maintains its own shape (line
 * buffer for plain text, partial-frame buffer for newline-delimited
 * JSON, etc.). The runner just allocates a fresh `{}` per run and
 * threads it through.
 */
export type ParserState = Record<string, unknown>;

/**
 * Build a snapshot of the spawn-relevant fields a profile would emit
 * given a `SpawnContext`. Exported for golden-snapshot tests so the
 * suite asserts on a stable, JSON-serialisable shape instead of
 * comparing argv arrays line-by-line.
 */
export interface ProviderSpawnSnapshot {
  readonly id: string;
  readonly argv: ReadonlyArray<string>;
  readonly envKeys: ReadonlyArray<string>;
}

/**
 * Helper used by golden tests. Captures the keys of the env merge (not
 * values — secrets must never land in fixtures) and the full argv.
 */
export function snapshotProfileSpawn(
  profile: ProviderProfile,
  ctx: SpawnContext,
): ProviderSpawnSnapshot {
  const argv = profile.buildArgv(ctx);
  const env = profile.buildEnv(ctx);
  return {
    id: profile.id,
    argv,
    envKeys: Object.keys(env).sort(),
  };
}

/**
 * Synthesise a {@link ProviderProfile} from the existing
 * {@link RuntimeAgentDef}. Built as a delegating wrapper so the
 * launcher / detection layers that still want the wide
 * `RuntimeAgentDef` shape continue to work unchanged — both surfaces
 * derive from the same source.
 *
 * The default `parseStreamLine` delegates to the project's existing
 * per-format parser selector; callers can pass a custom override when
 * the parser needs profile-local state (none today).
 */
export function toProviderProfile(
  def: RuntimeAgentDef,
  hooks: {
    parseStreamLine: (line: string, state: ParserState) => AgentEvent[];
    classifyError: (stderr: string) => ClassifiedError;
  },
): ProviderProfile {
  return {
    id: def.id,
    displayName: def.name,
    binResolution: {
      kind: 'argv-list',
      candidates: [def.bin, ...(def.fallbackBins ?? [])],
    },
    authType: deriveAuthType(def),
    envVars: deriveEnvVars(def),
    systemPromptStrategy: def.systemPromptStrategy,
    streamFormat: def.streamFormat,
    supportedFeatures: {
      // Conservative defaults — profiles can be enriched ticket-by-ticket
      // as the per-feature support is verified end-to-end.
      thinking: def.streamFormat === 'claude-stream-json',
      toolUse: def.streamFormat !== 'plain',
      mcp: def.mcpDiscovery !== undefined && def.mcpDiscovery !== 'none',
      cancellation: true,
      multimodal: def.supportsImagePaths === true,
    },
    buildArgv(ctx: SpawnContext): string[] {
      return def.buildArgs(
        ctx.prompt,
        [...ctx.imagePaths],
        ctx.extraAllowedDirs ? [...ctx.extraAllowedDirs] : undefined,
        ctx.options,
        ctx.runtimeContext,
      );
    },
    buildEnv(ctx: SpawnContext): Record<string, string> {
      const baseline = { ...(def.env ?? {}) };
      // The `env` field on RuntimeAgentDef is static; runtime overrides
      // (user Settings) merge at the launcher level, not here. Returning
      // only the declared additions keeps the snapshot small and
      // secret-free.
      void ctx;
      return baseline;
    },
    parseStreamLine: hooks.parseStreamLine,
    classifyError: hooks.classifyError,
  };
}

function deriveAuthType(def: RuntimeAgentDef): AuthType {
  if (def.requiredEnvKeys && def.requiredEnvKeys.length > 0) return 'api-key-env';
  // Claude / Cursor / Copilot use CLI login flows; surface as oauth-cli.
  if (def.id === 'claude' || def.id === 'cursor-agent' || def.id === 'copilot') {
    return 'oauth-cli';
  }
  return 'none';
}

function deriveEnvVars(def: RuntimeAgentDef): ReadonlyArray<EnvVarDeclaration> {
  const required = def.requiredEnvKeys ?? [];
  const optional = (def.envOverrideKeys ?? []).filter((k) => !required.includes(k));
  return [
    ...required.map((name) => ({
      name,
      required: true,
      description: `Required by ${def.name}`,
    })),
    ...optional.map((name) => ({
      name,
      required: false,
      description: `Optional override for ${def.name}`,
    })),
  ];
}
