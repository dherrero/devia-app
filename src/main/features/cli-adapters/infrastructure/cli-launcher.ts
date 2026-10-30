import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import type { RuntimeAgentDef } from '../domain/runtime-agent-def';
import type { AgentEvent } from '../../../../shared/domain/agent-event';
import type {
  AgentAnswer,
  AgentSession,
  AgentSessionIo,
  AgentUiRequest,
  PreparedRun,
} from '../../agents/domain';
import { buildSpawnEnv, prependToPath } from './spawn-env';
import { resolveAgentBin } from './resolve-bin';
import { resolveOnPath } from './detection/path-resolver';
import { createCommandInvocation } from './spawn-invocation';
import { killProcessTree } from './kill-tree';
import {
  checkWindowsCmdShimCommandLineBudget,
  checkWindowsDirectExeCommandLineBudget,
} from './prompt-budget';
import { classify, classifyError } from './error-classifier';
import { redactEnvForLog } from './secret-redact';
import { RunLogger } from '../../claude-runner/infrastructure/run-logger';
import { createRawStreamLogger, shouldEnableRawLogger } from './raw-stream-logger';

import type { CancelReason, ErrorClassification } from '../../../../shared/domain/agent-event';
import type { ClassifiedError } from '../../../../shared/domain/cli-errors';

/**
 * True when the app is not packaged (development mode).
 * Used only for the low-level byte-level verbose logs (stdout chunks).
 * The human-readable RunLogger runs in both dev and production.
 */
const IS_DEV = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const electronApp = (require('electron') as { app?: { isPackaged?: boolean } }).app;
    return electronApp?.isPackaged === false;
  } catch {
    return true; // Node.js / test context — always dev
  }
})();

// 5 min without any stdout/stderr — the CLI is wedged. Same heuristic the
// pre-multi-CLI `NodeClaudeRunner` shipped.
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;
const STDERR_BUFFER_MAX = 16 * 1024;

/**
 * One spawn. Everything agent-specific — argv, stdin, the system prompt, MCP
 * delivery, how stdout is decoded — was decided by the agent's mapper
 * (`prepared` + `openSession`, S-30 contract B). The def is only consulted for
 * what is about the PROCESS: which binary, its env policy, the Windows
 * command-line guards and the error classifier.
 */
export interface CliRunRequest {
  def: RuntimeAgentDef;
  cwd: string;
  prepared: PreparedRun;
  /** Opens the mapper's session over the spawned process. */
  openSession(io: AgentSessionIo): AgentSession;
  /** Run mode shown in console log header ('plan' | 'apply' | 'apply-yolo'). */
  mode?: string;
  /** Run id from the use case — used to correlate log lines. */
  runId?: string;
}

export interface CliRunHandlers {
  /** Receives a JSON-serialised `AgentEvent` string. One call per event.
   *  The renderer deserialises with `JSON.parse` and switches on `event.type`.
   *  IPC channel name (`claude:output`) is unchanged; only the payload format
   *  changed from raw JSONL to serialised AgentEvent. */
  onOutput(line: string): void;
  onDone(code: number): void;
  /**
   * Called on non-zero exit, spawn error, or deliberate cancellation.
   * `classification` is derived from the stderr tail by `classifyError`
   * (legacy 5-value union, preserved for downstream consumers).
   * `classifiedError` carries the richer {@link FailoverReason}-based
   * taxonomy introduced in E-DSK-09 #262 — IPC adapters forward the
   * `reason` / `hint` / `retryAfterSeconds` fields onto `process:end`
   * so the renderer can branch on the recovery action.
   * `signal` is set when the process was killed by a signal (e.g. `'SIGTERM'`).
   * `cancelReason` is set when the run was deliberately terminated
   * (REV-AGENT-CORE-011) — `'user'`, `'idle'`, or `'question_timeout'`.
   */
  onError(
    message: string,
    classification?: ErrorClassification,
    signal?: string,
    cancelReason?: CancelReason,
    classifiedError?: ClassifiedError,
  ): void;
  /**
   * A dialog the agent raised natively (ACP permission, pi extension UI).
   * Return true when a card will be drawn — the answer then comes back through
   * the handle's `answer`; false lets the session apply its headless default.
   */
  onUiRequest(request: AgentUiRequest): boolean;
}

export interface CliProcessHandle {
  /**
   * Terminate the child process. The optional `reason` is captured by the
   * launcher and forwarded to `onError` as the `cancelReason` so the renderer
   * can distinguish user cancel vs idle vs question-timeout (REV-AGENT-CORE-011).
   * Defaults to `'user'` when called by the project-stop IPC handlers.
   */
  kill(reason?: CancelReason): void;
  /**
   * Deliver an answer through the agent's native channel. False when the
   * session has no such pending request (or no process was ever spawned).
   */
  answer(callId: string, answer: AgentAnswer): boolean;
}

export interface CliLauncher {
  launch(req: CliRunRequest, handlers: CliRunHandlers): CliProcessHandle;
}

const NOT_SPAWNED: CliProcessHandle = { kill: () => undefined, answer: () => false };

/**
 * Single launcher used by every agent: resolves the binary, composes the env,
 * spawns, writes the prepared stdin, hands stdout to the mapper's session, and
 * owns the process lifecycle (idle watchdog, cancel reasons, exit
 * classification).
 */
export class ChildProcessCliLauncher implements CliLauncher {
  launch(req: CliRunRequest, handlers: CliRunHandlers): CliProcessHandle {
    const { def, prepared } = req;
    const args = [...prepared.args];
    const runId = req.runId ?? randomUUID();
    const logger = new RunLogger(def.id, runId, req.cwd, req.mode ?? 'apply');

    // Resolve the actual binary to spawn (native binary for Codex on Windows).
    const resolution = resolveAgentBin(def, process.env);
    if (resolution.diagnostic !== null) {
      console.warn(`[cli-adapters:${def.id}] ${resolution.diagnostic}`);
    }

    // REV-AGENT-CORE-009: Windows command-line guards. Only fire on Windows
    // for argv-bound (`maxPromptArgBytes` set) adapters. POSIX returns null
    // immediately. Two flavours: cmd-shim (.cmd/.bat) and direct .exe.
    if (def.maxPromptArgBytes != null) {
      const launchPathForGuard = resolution.launchPath ?? def.bin;
      const guardError =
        checkWindowsCmdShimCommandLineBudget(def, launchPathForGuard, args) ??
        checkWindowsDirectExeCommandLineBudget(def, launchPathForGuard, args);
      if (guardError !== null) {
        handlers.onError(guardError.message);
        return NOT_SPAWNED;
      }
    }

    // Compose the child environment: parent env → def.env → the prepared
    // overrides (allowlist-filtered) → Claude ANTHROPIC_API_KEY strip.
    const { env, stripped } = buildSpawnEnv(def, { ...prepared.env });
    if (stripped.length > 0) {
      console.warn(
        `[cli-adapters:${def.id}] stripped env keys (no ANTHROPIC_BASE_URL): ${stripped.join(', ')}`,
      );
    }
    // `PWD` must name the child's real cwd. Inherited, it names DEVIA's own
    // working directory (`/` for an app launched from Finder), and some CLIs
    // trust it over `process.cwd()`: OpenCode resolved its project — and the
    // `opencode.json` carrying Devia's MCP servers — from it, so it ran against
    // the wrong folder with none of Devia's tools (found by S-30 T-344).
    Object.assign(env, prepared.agentEnv ?? {});
    env['PWD'] = req.cwd;

    // Prepend native binary dir to child PATH (so nested tool calls resolve).
    // `prependToPath` uses a case-insensitive key lookup so Windows envs that
    // store the variable as 'Path' rather than 'PATH' are handled correctly.
    if (resolution.childPathPrepend.length > 0) {
      prependToPath(env, resolution.childPathPrepend);
    }

    // Codex on Windows: `resolution.launchPath` is the native `.exe`. Everyone
    // else: resolve the full path ourselves — Node's `spawn` with `shell:
    // false` does not consult PATHEXT on Windows, so a bare `codex` never
    // matches `codex.cmd` (UV_ENOENT). On POSIX this is harmless; when nothing
    // is on PATH we fall back to the bare name so `spawn` surfaces its ENOENT.
    let launchBin: string;
    if (resolution.launchKind === 'codex-native' && resolution.launchPath) {
      launchBin = resolution.launchPath;
    } else {
      const candidates = [def.bin, ...(def.fallbackBins ?? [])];
      const fullPath = candidates.map((b) => resolveOnPath(b)).find((p): p is string => p !== null);
      launchBin = fullPath ?? resolution.launchPath ?? def.bin;
    }
    if (IS_DEV) process.stdout.write(`\x1b[2m[devia:launcher] resolved bin → "${launchBin}"\x1b[0m\n`);

    // In packaged apps launched from the macOS Finder (or Linux .desktop),
    // the inherited PATH is minimal (/usr/bin:/bin:/usr/sbin:/sbin).
    // npm-installed CLIs use a shebang `#!/usr/bin/env node` that fails
    // because `node` lives in /opt/homebrew/bin or /usr/local/bin —
    // directories not on the packaged-app PATH. Resolve `node` the same
    // way we resolved the CLI binary (via the extended toolchain dirs) and
    // prepend its directory to the child PATH so the shebang works.
    if (!IS_DEV && process.platform !== 'win32') {
      const nodePath = resolveOnPath('node');
      if (nodePath) {
        const nodeDir = path.dirname(nodePath);
        prependToPath(env, [nodeDir]);
        if (IS_DEV) process.stdout.write(`\x1b[2m[devia:launcher] prepended node dir → "${nodeDir}"\x1b[0m\n`);
      }
    }

    // Cross-platform invocation shape: identity on POSIX and on Windows
    // for `.exe` targets; cmd.exe-wrapped with `windowsVerbatimArguments`
    // for Windows `.cmd` / `.bat` shims.
    const invocation = createCommandInvocation({ command: launchBin, args, env });

    // DEV-only: dump the exact spawn — full argv plus the Devia env overrides
    // with secret-looking values masked. Never logs the inherited process env
    // nor any unmasked secret.
    if (IS_DEV) {
      process.stdout.write(
        `\x1b[2m[devia:launcher] spawn → ${invocation.command} ${invocation.args.join(' ')}\x1b[0m\n` +
        `\x1b[2m[devia:launcher]   cwd=${req.cwd}  env=${redactEnvForLog({ ...prepared.env })}\x1b[0m\n`,
      );
    }

    let proc: ChildProcessByStdio<Writable | null, Readable, Readable>;
    try {
      proc = spawn(invocation.command, invocation.args, {
        cwd: req.cwd,
        env,
        stdio: [prepared.stdin.kind === 'none' ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false,
        windowsVerbatimArguments: invocation.windowsVerbatimArguments,
      }) as ChildProcessByStdio<Writable | null, Readable, Readable>;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      handlers.onError(`No se pudo lanzar ${def.bin}: ${message}`);
      return NOT_SPAWNED;
    }

    let lastActivity = Date.now();
    // Tracks the cause of a deliberate kill so the close handler can forward
    // it as the `cancelReason` (REV-AGENT-CORE-011). `undefined` means natural
    // exit / crash. Set by `handle.kill(reason)` or by the idle watchdog.
    let pendingCancelReason: CancelReason | undefined;
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity > IDLE_TIMEOUT_MS) {
        clearInterval(watchdog);
        pendingCancelReason = 'idle';
        console.warn(`[devia] Idle watchdog: killing ${def.id} process after 5 minutes of inactivity (cwd: ${req.cwd})`);
        killProcessTree(
          proc.pid,
          invocation.windowsVerbatimArguments,
          () => { try { proc.kill('SIGTERM'); } catch { /* swallow */ } },
        );
      }
    }, 30_000);

    // Serialise each AgentEvent to a JSON string before handing it to the
    // IPC transport. The renderer's consumeAgentEvent deserialises it.
    const emit = (event: AgentEvent): void => {
      logger.onEvent(event);
      handlers.onOutput(JSON.stringify(event));
    };

    // Side-effect raw capture of the child process output for parser/adapter
    // debugging. No-op in production unless `DEVIA_LOG_RAW_CLI=1` is set. The
    // logger never blocks the session path — writes are best-effort.
    const rawLogger = createRawStreamLogger({
      enabled: shouldEnableRawLogger(IS_DEV),
      agentId: def.id,
      runId,
    });

    if (IS_DEV) process.stdout.write(`\x1b[2m[devia:launcher] pid=${proc.pid ?? '?'} bin=${resolution.launchPath ?? def.bin}\x1b[0m\n`);

    proc.stdout.on('data', (data: Buffer) => {
      lastActivity = Date.now();
      rawLogger.write('stdout', data.toString());
    });

    let stderrBuf = '';
    proc.stderr.on('data', (data: Buffer) => {
      lastActivity = Date.now();
      const text = data.toString();
      rawLogger.write('stderr', text);
      stderrBuf += text;
      if (stderrBuf.length > STDERR_BUFFER_MAX) {
        stderrBuf = stderrBuf.slice(-Math.floor(STDERR_BUFFER_MAX * 0.8));
      }
      process.stderr.write(`[${def.id}] ${text}`);
    });

    // The mapper's session decodes stdout (a stream parser, or an RPC driver
    // that also owns stdin) and translates answers to the agent's wire.
    const session = req.openSession({
      process: proc,
      stdin: proc.stdin,
      stdout: proc.stdout,
      emit,
      requestUi: (request) => handlers.onUiRequest(request),
    });

    const { stdin: stdinPlan } = prepared;
    if ((stdinPlan.kind === 'text' || stdinPlan.kind === 'stream') && proc.stdin) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        // EPIPE = the child exited before consuming the prompt; the close
        // handler already covers that.
        if (err.code !== 'EPIPE') handlers.onError(`stdin: ${err.message}`);
      });
      try {
        proc.stdin.write(stdinPlan.payload);
        // `stream` keeps stdin open for mid-turn writes; the session closes it.
        if (stdinPlan.kind === 'text') proc.stdin.end();
      } catch (err) {
        handlers.onError(`stdin: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    proc.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      clearInterval(watchdog);
      session.flush();
      rawLogger.close();

      // REV-AGENT-CORE-011: a known cancelReason takes precedence over any
      // natural-exit / error inference. The renderer needs the structured
      // reason to render the right system message and toggle the Retry button.
      if (pendingCancelReason !== undefined) {
        const label =
          pendingCancelReason === 'user' ? 'Cancelado por ti.' :
          pendingCancelReason === 'idle' ? 'Cancelado por inactividad (5 min sin salida).' :
          'Cancelado: no respondiste a la pregunta en 5 minutos.';
        logger.onFail(label);
        handlers.onError(label, undefined, signal ?? undefined, pendingCancelReason);
        return;
      }

      // Claude Code -p exits with code=null + SIGTERM when it completes naturally.
      // Treat this as success unless stderr has content (a real crash before exit).
      const isNaturalExit =
        code === null &&
        signal === 'SIGTERM' &&
        stderrBuf.trim().length === 0;

      if (code !== 0 && !isNaturalExit) {
        const tail = stderrBuf.trim().slice(-800)
          || `${def.bin} salió con código ${code ?? 'desconocido'}`;
        const classified = classify(def.id, tail);
        const classification = classifyError(def.id, tail);
        logger.onFail(tail);
        handlers.onError(tail, classification, signal ?? undefined, undefined, classified);
        return;
      }
      logger.onDone();
      handlers.onDone(code ?? 0);
    });

    proc.on('error', (err: Error) => {
      clearInterval(watchdog);
      rawLogger.close();
      logger.onFail(err.message);
      const classified = classify(def.id, err.message);
      const classification = classifyError(def.id, err.message);
      handlers.onError(err.message, classification, undefined, undefined, classified);
    });

    return {
      kill: (reason?: CancelReason) => {
        // REV-AGENT-CORE-011: capture the cancellation cause before SIGTERM so
        // the close handler can forward it as `cancelReason`. Default to 'user'
        // for legacy callers that don't pass a reason (StopProjectUseCase, etc.).
        if (pendingCancelReason === undefined) {
          pendingCancelReason = reason ?? 'user';
        }
        // RPC sessions close cleanly (cancel/abort + stdin EOF) so the agent
        // tears down its runtime before the SIGTERM fallback fires.
        session.abort();
        // UC-FIX-003: on Windows, when the spawn went through the cmd.exe shim,
        // kill the entire process tree so the underlying agent does not orphan.
        killProcessTree(
          proc.pid,
          invocation.windowsVerbatimArguments,
          () => { try { proc.kill('SIGTERM'); } catch { /* swallow */ } },
        );
      },
      answer: (callId: string, answer: AgentAnswer) => session.answer(callId, answer),
    };
  }
}
