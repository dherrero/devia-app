/**
 * Formal `AgentProvider` interface plus all the types that provider modules
 * use. Defined in shared/domain so that both main-process orchestration code
 * and renderer-side UI types (e.g. `Capabilities`) can import from a single
 * location without Electron imports.
 *
 * Main-process only: `ChildProcessLike`, `ProviderSession`, `Invocation`.
 * Cross-process safe: `Capabilities`, `DetectionResult`, `ProviderEnvironment`.
 *
 * `NormalizedEvent` is imported from normalized-event.ts (TS-Agent-04).
 */

import type { NormalizedEvent } from './normalized-event';

// ── Environment ───────────────────────────────────────────────────────────────

export interface ProviderEnvironment {
  path: string[];
  platform: 'darwin' | 'linux' | 'win32';
  envVars: Readonly<Record<string, string>>;
  configuredOverrides?: Readonly<Record<string, string>>;
}

// ── Detection ─────────────────────────────────────────────────────────────────

export interface DetectionResult {
  available: boolean;
  executablePath?: string;
  version?: string;
  authStatus: 'ok' | 'missing' | 'unknown';
  authMessage?: string;
}

// ── Capabilities ──────────────────────────────────────────────────────────────

export interface Capabilities {
  streaming: boolean;
  thinkingTraces: boolean;
  interactiveTools: boolean;
  fileTools: boolean;
  imageInputs: boolean;
  resume: boolean;
  sandboxModel: 'cwd' | 'workspace' | 'none';
  contextWindowHint?: number;
}

// ── Request / Invocation ──────────────────────────────────────────────────────

export interface ChatTurnSummary {
  role: 'user' | 'assistant';
  content: string;
}

export interface ProviderRequest {
  runId: string;
  prompt: string;
  history?: ChatTurnSummary[];
  cwd: string;
  imagePaths?: string[];
  extraReadableDirs?: string[];
  model?: string;
  reasoningLevel?: string;
  timeoutMs?: number;
}

export interface Invocation {
  command: string;
  args: string[];
  env: Readonly<Record<string, string>>;
  stdinMode: 'ignore' | 'pipe-text' | 'pipe-jsonl';
  initialStdinFrames?: string[];
}

// ── Errors ────────────────────────────────────────────────────────────────────

export type ProviderPrepareCode =
  | 'PROMPT_TOO_LARGE'
  | 'BAD_MODEL'
  | 'BAD_CONFIG'
  | 'VALIDATION_FAILED';

export class ProviderPrepareError extends Error {
  readonly code: ProviderPrepareCode;
  readonly retryable: boolean;

  constructor(code: ProviderPrepareCode, message: string, retryable: boolean) {
    super(message);
    this.name = 'ProviderPrepareError';
    this.code = code;
    this.retryable = retryable;
  }
}

// ── Child process abstraction (main-process only) ─────────────────────────────

// Minimal duck-typed stream interfaces that avoid importing Node's 'stream'
// module, keeping this file importable in both main-process and renderer.
export interface ReadableLike {
  on(event: string, listener: (...args: unknown[]) => void): this;
  pipe?(...args: unknown[]): unknown;
}
export interface WritableLike {
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(cb?: () => void): this;
}

/**
 * Minimal interface that `attach()` receives instead of Node's concrete
 * `ChildProcess`, allowing test doubles without a real binary.
 */
export interface ChildProcessLike {
  readonly stdout: ReadableLike | null;
  readonly stderr: ReadableLike | null;
  readonly stdin: WritableLike | null;
  readonly pid?: number;
  kill(signal?: string | number): boolean;
  on(event: 'close', listener: (code: number | null, signal: string | null) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
}

// ── Provider session ──────────────────────────────────────────────────────────

export interface ProviderSession {
  readonly events: AsyncIterable<NormalizedEvent>;
  submitToolResult?(toolUseId: string, content: string, isError?: boolean): Promise<void>;
  cancel(reason: 'user' | 'timeout' | 'shutdown'): Promise<void>;
}

// ── Provider interface ────────────────────────────────────────────────────────

export interface AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly metadata: {
    installUrl?: string;
    docsUrl?: string;
    homepage?: string;
  };

  /**
   * Probes availability. Must never throw; returns `{ available: false }`
   * on any failure. Must respect a ~3 s timeout.
   */
  detect(env: ProviderEnvironment): Promise<DetectionResult>;

  /**
   * Returns the capabilities this provider offers given its detection result.
   * Pure function — no I/O.
   */
  capabilities(detection: DetectionResult): Capabilities;

  /**
   * Validates the request and returns everything the process host needs to
   * spawn the child. Throws `ProviderPrepareError` for validation failures.
   */
  prepare(req: ProviderRequest): Promise<Invocation>;

  /**
   * Attaches to a running child process and returns a session. Must never
   * throw synchronously; failures surface as `NormalizedEvent` error events.
   */
  attach(child: ChildProcessLike, req: ProviderRequest): ProviderSession;
}
