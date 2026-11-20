import { newQuickJSWASMModule, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten';

/**
 * Runs the agent's script inside QuickJS compiled to WASM (S-50). The script sees
 * exactly two globals: `tools` (a proxy whose calls go through the host `bridge`)
 * and `console.log`. There is no `process`, `require`, `fetch`, timers or
 * filesystem because the engine simply does not have them.
 *
 * Cost (measured 2026-11-20, Node 22 on Apple silicon, quickjs-emscripten 0.32):
 * a few ms to instantiate the WASM module plus ~6 ms for a runtime+context, so a
 * fresh module and runtime per `run_script` is fine.
 */

export interface SandboxOptions {
  /** Wall-clock budget for the WHOLE run, CPU and awaiting tool calls alike. */
  timeoutMs: number;
  memoryBytes: number;
  /** Cap on the serialized `return` value. */
  maxOutputBytes: number;
  /** Cap on the text `console.log` may produce. */
  maxLogBytes: number;
}

/** The host side of `tools.<server>.<tool>(args)`. */
export type BridgeFn = (server: string, tool: string, args: unknown) => Promise<unknown>;

export type SandboxResult =
  | { ok: true; value: unknown; logs: string[] }
  | { ok: false; kind: 'timeout' | 'memory' | 'runtime' | 'output_too_large'; message: string; line?: number; logs: string[] };

const SCRIPT_FILE = 'script.js';
const MAX_STACK_BYTES = 512 * 1024;

const PRELUDE = `
globalThis.console = {
  log: (...a) => __log(a.map((x) => (typeof x === 'string' ? x : String(JSON.stringify(x)))).join(' ')),
};
globalThis.tools = new Proxy({}, {
  get: (_t, server) => typeof server !== 'string' ? undefined : new Proxy({}, {
    get: (_t2, tool) => typeof tool !== 'string' ? undefined : async (args) =>
      JSON.parse(await __call(server, tool, JSON.stringify(args === undefined ? null : args))),
  }),
});
`;

interface VmError {
  name?: string;
  message?: string;
  stack?: string;
}

function toVmError(dumped: unknown): VmError {
  if (typeof dumped === 'object' && dumped !== null) return dumped as VmError;
  return { message: String(dumped) };
}

function classify(err: VmError, logs: string[]): SandboxResult {
  const message = err.message ?? 'script failed';
  if (/interrupted/i.test(message)) {
    return { ok: false, kind: 'timeout', message: 'The script ran out of time and was stopped.', logs };
  }
  if (/out of memory/i.test(message)) {
    return { ok: false, kind: 'memory', message: 'The script ran out of memory and was stopped.', logs };
  }
  const line = err.stack ? /script\.js:(\d+)/.exec(err.stack)?.[1] : undefined;
  return {
    ok: false,
    kind: 'runtime',
    message: err.name && err.name !== 'Error' ? `${err.name}: ${message}` : message,
    ...(line !== undefined && { line: Number(line) }),
    logs,
  };
}

export async function runInSandbox(js: string, bridge: BridgeFn, opts: SandboxOptions): Promise<SandboxResult> {
  // A module of its own per run, not the shared `getQuickJS()` singleton: after an
  // out-of-memory script QuickJS can abort while freeing its runtime
  // (`Assertion failed: list_empty(&rt->gc_obj_list)`), and an aborted WASM module
  // is dead for everyone. Isolated this way, only that run is lost.
  const QuickJS = await newQuickJSWASMModule();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryBytes);
  runtime.setMaxStackSize(MAX_STACK_BYTES);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + opts.timeoutMs));
  const vm: QuickJSContext = runtime.newContext();

  const logs: string[] = [];
  let logBytes = 0;
  let logsTruncated = false;
  let alive = true;
  let timer: NodeJS.Timeout | undefined;
  const handles: QuickJSHandle[] = [];
  const deferreds: { dispose: () => void }[] = [];

  try {
    const logFn = vm.newFunction('__log', (textH) => {
      if (logsTruncated) return;
      const text = vm.getString(textH);
      const room = opts.maxLogBytes - logBytes;
      if (text.length > room) {
        if (room > 0) logs.push(text.slice(0, room));
        logs.push('[logs truncated]');
        logsTruncated = true;
        return;
      }
      logs.push(text);
      logBytes += text.length;
    });
    handles.push(logFn);
    vm.setProp(vm.global, '__log', logFn);

    const callFn = vm.newFunction('__call', (serverH, toolH, argsH) => {
      const server = vm.getString(serverH);
      const tool = vm.getString(toolH);
      const argsJson = vm.getString(argsH);
      const deferred = vm.newPromise();
      deferreds.push(deferred);
      deferred.settled.then(() => {
        if (alive) runtime.executePendingJobs();
      });
      let args: unknown;
      try {
        args = JSON.parse(argsJson);
      } catch {
        args = null;
      }
      bridge(server, tool, args).then(
        (value) => {
          if (!alive) return;
          const h = vm.newString(JSON.stringify(value ?? null));
          deferred.resolve(h);
          h.dispose();
        },
        (err: unknown) => {
          if (!alive) return;
          const message = err instanceof Error ? err.message : String(err);
          const denied = typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'TOOL_DENIED';
          const h = vm.newError({ name: denied ? 'ToolDeniedError' : 'Error', message });
          deferred.reject(h);
          h.dispose();
        },
      );
      return deferred.handle;
    });
    handles.push(callFn);
    vm.setProp(vm.global, '__call', callFn);

    const prelude = vm.evalCode(PRELUDE, 'prelude.js');
    if (prelude.error) {
      const err = toVmError(vm.dump(prelude.error));
      prelude.error.dispose();
      return classify(err, logs);
    }
    prelude.value.dispose();

    // No newline before the body: line N of the script stays line N in stack traces.
    const wrapped = `(async()=>{const __r=await (async()=>{${js}\n})();return JSON.stringify(__r)??'null';})()`;
    const started = vm.evalCode(wrapped, SCRIPT_FILE);
    if (started.error) {
      const err = toVmError(vm.dump(started.error));
      started.error.dispose();
      return classify(err, logs);
    }

    const resolving = vm.resolvePromise(started.value);
    runtime.executePendingJobs();
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), opts.timeoutMs);
    });
    const outcome = await Promise.race([resolving, timeout]);
    if (outcome === 'timeout') {
      return { ok: false, kind: 'timeout', message: 'The script ran out of time and was stopped.', logs };
    }
    started.value.dispose();
    if (outcome.error) {
      const err = toVmError(vm.dump(outcome.error));
      outcome.error.dispose();
      return classify(err, logs);
    }
    const serialized = vm.getString(outcome.value);
    outcome.value.dispose();
    if (Buffer.byteLength(serialized, 'utf8') > opts.maxOutputBytes) {
      return {
        ok: false,
        kind: 'output_too_large',
        message: `The returned value is ${Buffer.byteLength(serialized, 'utf8')} bytes; the limit is ${opts.maxOutputBytes}. Filter or aggregate inside the script and return less.`,
        logs,
      };
    }
    return { ok: true, value: JSON.parse(serialized) as unknown, logs };
  } finally {
    alive = false;
    if (timer !== undefined) clearTimeout(timer);
    try {
      for (const d of deferreds) d.dispose();
      for (const h of handles) h.dispose();
      vm.dispose();
      runtime.dispose();
    } catch {
      // A teardown problem must not mask the script's own result.
    }
  }
}
