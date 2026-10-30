import type { RuntimeAgentDef } from '../domain/runtime-agent-def';

/**
 * Error returned when a composed prompt exceeds the adapter's argv byte
 * budget OR the platform's command-line limit. Callers should surface this to
 * the user before attempting to spawn the CLI so that opaque OS-level errors
 * (ENAMETOOLONG, Windows CreateProcess 32768-char limit) are never reached.
 */
export interface PromptBudgetError {
  /** Discriminant used by callers to handle this specific error type. */
  code: 'AGENT_PROMPT_TOO_LARGE';
  message: string;
  /** Actual byte length of the composed prompt (byte-budget guard).
   *  Marked optional so the union with command-line errors stays clean. */
  bytes?: number;
  /** Final command-line length after Windows quoting (Win-CreateProcess guards). */
  commandLineLength?: number;
  /** The limit that was breached. */
  limit: number;
}

/**
 * Windows `CreateProcess` `lpCommandLine` cap. Subtracting a safety margin
 * gives us headroom for late additions and avoids living on the edge of the
 * documented limit (32 767 wide chars).
 */
const WIN_CMDLINE_LIMIT = 32_767;
const WIN_HEADROOM = 256;
const WIN_EFFECTIVE_LIMIT = WIN_CMDLINE_LIMIT - WIN_HEADROOM;

/**
 * Pure pre-flight guard: checks whether `composed` fits within the agent's
 * `maxPromptArgBytes` budget.
 *
 * Returns `null` when:
 * - `def` is null or undefined (no agent selected).
 * - `def.maxPromptArgBytes` is not set (stdin-based agents; no argv limit).
 * - The prompt is within the declared budget.
 *
 * Returns a {@link PromptBudgetError} when the prompt exceeds the limit.
 *
 * This function never throws; it is safe to call at any stage of the
 * request pipeline.
 */
export function checkPromptArgvBudget(
  def: RuntimeAgentDef | null | undefined,
  composed: string,
): PromptBudgetError | null {
  try {
    if (def == null) {
      return null;
    }

    const limit = def.maxPromptArgBytes;
    if (limit == null) {
      return null;
    }

    const bytes = Buffer.byteLength(composed, 'utf8');
    if (bytes <= limit) {
      return null;
    }

    return {
      code: 'AGENT_PROMPT_TOO_LARGE',
      message:
        `Prompt is ${bytes} bytes but ${def.name} (${def.id}) has a ` +
        `maximum argv budget of ${limit} bytes. ` +
        `Reduce the prompt length before sending.`,
      bytes,
      limit,
    };
  } catch {
    // Safety net: never let a budget check crash the caller.
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────────────
// REV-AGENT-CORE-009: Windows CreateProcess command-line budget guards.
//
// Two flavours, dispatched by file extension of the resolved binary:
//   .cmd / .bat → goes through cmd.exe /d /s /c "<inner>", which doubles `"`
//                 and neutralises `%` to avoid env-var expansion (`"^%"`).
//   .exe / other → libuv's `quote_cmd_arg` rules apply: arg wrapped in `"…"`
//                 if it has whitespace or quotes, with `\` and `"` escaped.
//
// Reimplemented from the documented rules — no reference code copied.
// Both functions are pure and safely callable from POSIX hosts (they always
// return null when the binary path does not look Windows-shaped).
// ──────────────────────────────────────────────────────────────────────────

function isCmdShim(resolvedBin: string): boolean {
  return /\.(cmd|bat)$/i.test(resolvedBin);
}
function isWindowsExe(resolvedBin: string): boolean {
  // Drive-letter or .exe suffix → treat as Windows path.
  return /\.exe$/i.test(resolvedBin) || /^[A-Za-z]:[\\/]/.test(resolvedBin);
}

/**
 * libuv's `quote_cmd_arg` (used by Node's `child_process.spawn` for direct
 * `.exe` invocations on Windows). Returns the arg as it would appear inside
 * the final `lpCommandLine`, including any surrounding quotes.
 */
export function quoteWindowsExeArg(arg: string): string {
  // Empty arg → quoted empty string (libuv behaviour).
  if (arg.length === 0) return '""';
  // No special chars → pass through unchanged.
  if (!/[\s"]/.test(arg)) return arg;

  let out = '"';
  let bsCount = 0;
  for (let i = 0; i < arg.length; i++) {
    const ch = arg[i];
    if (ch === '\\') {
      bsCount++;
    } else if (ch === '"') {
      // Escape pending backslashes (each doubled) AND the quote.
      out += '\\'.repeat(bsCount * 2 + 1) + '"';
      bsCount = 0;
    } else {
      out += '\\'.repeat(bsCount) + ch;
      bsCount = 0;
    }
  }
  // Trailing backslashes before the closing quote get doubled.
  out += '\\'.repeat(bsCount * 2) + '"';
  return out;
}

/**
 * Compose the final Windows `lpCommandLine` for a direct .exe spawn.
 * Returns the full command line string (binary path + quoted args).
 */
export function composeWindowsExeCommandLine(resolvedBin: string, args: readonly string[]): string {
  const parts = [quoteWindowsExeArg(resolvedBin), ...args.map(quoteWindowsExeArg)];
  return parts.join(' ');
}

/**
 * Simulate cmd.exe's `/d /s /c "<inner>"` quoting. Doubles every `"` in the
 * inner string and neutralises `%` to avoid env-var expansion.
 */
export function composeWindowsCmdShimCommandLine(resolvedBin: string, args: readonly string[]): string {
  // The libuv-quoted command + args form the "inner" string cmd.exe runs.
  const inner = composeWindowsExeCommandLine(resolvedBin, args);
  // Quote-doubling + percent neutralisation.
  const escaped = inner.replace(/"/g, '""').replace(/%/g, '"^%"');
  return `cmd.exe /d /s /c "${escaped}"`;
}

function checkCmdLineLength(
  def: RuntimeAgentDef,
  cmdLine: string,
): PromptBudgetError | null {
  if (cmdLine.length <= WIN_EFFECTIVE_LIMIT) return null;
  return {
    code: 'AGENT_PROMPT_TOO_LARGE',
    message:
      `Prompt too large for Windows command-line after escaping; ` +
      `shorten the prompt or pick an adapter that uses stdin. ` +
      `(${def.name}: command line is ${cmdLine.length} chars; cap ${WIN_EFFECTIVE_LIMIT}.)`,
    commandLineLength: cmdLine.length,
    limit: WIN_EFFECTIVE_LIMIT,
  };
}

/**
 * Pre-flight guard for `.cmd` / `.bat` shims on Windows. Returns `null` on
 * POSIX hosts and for non-shim binaries. Never throws.
 */
export function checkWindowsCmdShimCommandLineBudget(
  def: RuntimeAgentDef,
  resolvedBin: string,
  args: readonly string[],
): PromptBudgetError | null {
  try {
    if (process.platform !== 'win32') return null;
    if (!isCmdShim(resolvedBin)) return null;
    return checkCmdLineLength(def, composeWindowsCmdShimCommandLine(resolvedBin, args));
  } catch { return null; }
}

/**
 * Pre-flight guard for direct `.exe` (and bare drive-letter) spawns on
 * Windows. Returns `null` on POSIX hosts and for non-Windows-looking
 * binaries. Never throws.
 */
export function checkWindowsDirectExeCommandLineBudget(
  def: RuntimeAgentDef,
  resolvedBin: string,
  args: readonly string[],
): PromptBudgetError | null {
  try {
    if (process.platform !== 'win32') return null;
    if (isCmdShim(resolvedBin)) return null;
    if (!isWindowsExe(resolvedBin)) return null;
    return checkCmdLineLength(def, composeWindowsExeCommandLine(resolvedBin, args));
  } catch { return null; }
}

// Test-only exports: lets tests on POSIX hosts exercise the quoting math
// directly. Not used in production code.
export const __test = { isCmdShim, isWindowsExe, checkCmdLineLength };
