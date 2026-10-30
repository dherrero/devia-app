/**
 * Cross-platform spawn-invocation shape.
 *
 * Every place in Devia that spawns a child process (detection probes,
 * the run launcher, future workers) routes its `{ command, args }` pair
 * through `createCommandInvocation` first. The function is a no-op on
 * macOS / Linux and a no-op on Windows for plain `.exe` targets — the
 * only case it transforms is a Windows `.cmd` / `.bat` shim, which Node
 * cannot launch directly with `spawn`/`execFile` and `shell: false`.
 *
 * Pattern mirrors the reference Open Design `createCommandInvocation`
 * (independently re-implemented, not copied):
 *
 *   1. Wrap the shim in `cmd.exe /d /s /c "<line>"`. Node's `execFile`/
 *      `spawn` cannot launch a batch file directly; bypassing cmd.exe
 *      ourselves keeps `shell: false` and avoids Node's per-shell
 *      double quoting.
 *
 *   2. Set `windowsVerbatimArguments: true` so Node does NOT apply
 *      CommandLineToArgvW escaping to each argv element. Without this,
 *      a shim path containing spaces (`C:\Users\First Last\AppData\
 *      Roaming\npm\codex.cmd`) is mangled by Node, then re-mangled by
 *      cmd.exe's `/s /c` strip, and the spawn fails with "not
 *      recognized as an internal or external command".
 *
 *   3. Per-arg, escape `%` with `"^%"`. cmd.exe runs percent-expansion
 *      on the inner line — even inside `"..."` segments — so a stray
 *      `%FOO%` substring would substitute a live env value. Toggling
 *      out of the quote, escaping the next char with `^`, and toggling
 *      back in produces a literal `%` byte the child receives unmodified.
 *
 * Callers on POSIX get back the input unchanged with
 * `windowsVerbatimArguments: false`, so the same code path is safe to
 * use everywhere.
 */

export interface CommandInvocation {
  command: string;
  args: string[];
  /** Set this verbatim on the `spawn`/`execFile` options object. */
  windowsVerbatimArguments: boolean;
}

export interface CommandInvocationRequest {
  command: string;
  args?: readonly string[];
  /** Used to look up `ComSpec`. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Quotes a single argument for use inside a `cmd.exe /d /s /c "<line>"`
 * invocation, ensuring every byte reaches the child as a literal.
 *
 * Security model:
 *   - Shell meta-characters `& | < > ^ " % \s` are detected by the regex.
 *   - `&`, `|`, `<`, `>`, `^` — the outer `"…"` wrapper neutralises all of
 *     these because cmd.exe stops treating them as operators inside a double-
 *     quoted segment. No per-char escaping is needed for them.
 *   - `"` — doubled inside the outer quotes (`""`) so the child receives one
 *     literal `"`.
 *   - `%` — special case: percent-expansion runs BEFORE quote parsing with
 *     `/s /c`, so `%FOO%` inside `"…"` would still expand to the env value.
 *     The `"^%"` toggle (exit quote, `^`-escape the `%`, re-enter quote)
 *     produces a literal `%` byte that cmd.exe passes through unmodified.
 *
 * Exported for tests.
 */
export function quoteWindowsCommandArg(value: string): string {
  if (!/[\s"&<>|^%]/.test(value)) return value;
  const escaped = value.replace(/"/g, '""').replace(/%/g, '"^%"');
  return `"${escaped}"`;
}

function buildCmdShimInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CommandInvocation {
  const inner = [command, ...args].map(quoteWindowsCommandArg).join(' ');
  return {
    command: env['ComSpec'] ?? process.env['ComSpec'] ?? 'cmd.exe',
    args: ['/d', '/s', '/c', `"${inner}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * Cross-platform: returns `{ command, args, windowsVerbatimArguments }`
 * ready to hand to `child_process.spawn` / `execFile`.
 *
 *   - macOS / Linux: identity transform, `windowsVerbatimArguments: false`.
 *   - Windows + `.exe` (or any non-batch target): identity transform.
 *   - Windows + `.cmd` / `.bat`: wrapped in `cmd.exe /d /s /c "<line>"`
 *     with verbatim arguments and per-arg escaping.
 */
export function createCommandInvocation(
  request: CommandInvocationRequest,
): CommandInvocation {
  const args = request.args ? request.args.slice() : [];
  if (process.platform === 'win32' && /\.(bat|cmd)$/i.test(request.command)) {
    return buildCmdShimInvocation(request.command, args, request.env ?? process.env);
  }
  return {
    command: request.command,
    args,
    windowsVerbatimArguments: false,
  };
}
