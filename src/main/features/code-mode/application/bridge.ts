import type { CodeModeEvent } from '../../../../shared/domain/code-mode';
import { toIdentifier } from '../domain/declarations';
import type { CatalogTool, ToolAccess } from '../domain/tool-catalog';
import type { McpClientPool } from '../infrastructure/mcp-client-pool';
import type { BridgeFn } from '../infrastructure/sandbox';

/**
 * The only door out of the sandbox (S-50). Every `tools.<server>.<tool>(...)` in a
 * script ends here, where the policy is applied in the main code and not in the
 * script: the script can only ask.
 */

export interface BridgePolicy {
  mode: 'plan' | 'apply' | 'apply-yolo';
  maxCalls: number;
  maxCallsPerTool: number;
  maxConcurrency: number;
  /** `"<server>.<tool>"` → the user's own read/write ruling for that tool. */
  writeOverrides?: Record<string, ToolAccess>;
}

export class ToolDeniedError extends Error {
  readonly code = 'TOOL_DENIED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ToolDeniedError';
  }
}

export type Decision = { allow: true } | { allow: false; reason: string };

/**
 * v1: scripts only read. A tool is allowed when it is read-only (after the user's
 * override), whatever the mode: a plan-mode run must not write, and an apply run
 * keeps its writes on the agent's own, individually approved tool calls.
 * This is the single place a later phase widens (batched approval of writes).
 */
export function decide(tool: CatalogTool, policy: BridgePolicy): Decision {
  const access = policy.writeOverrides?.[`${tool.server}.${tool.name}`] ?? (tool.readOnly ? 'read' : 'write');
  if (access === 'read') return { allow: true };
  return {
    allow: false,
    reason:
      `${tool.server}.${tool.name} is not read-only, and scripts can only read. ` +
      'Return what you found and make the change with a normal tool call.',
  };
}

export interface BridgeDeps {
  pool: Pick<McpClientPool, 'call'>;
  catalog: readonly CatalogTool[];
  policy: BridgePolicy;
  emit: (event: CodeModeEvent) => void;
  scriptId: string;
}

class Semaphore {
  private free: number;
  private readonly waiters: (() => void)[] = [];
  constructor(size: number) {
    this.free = Math.max(1, size);
  }
  async acquire(): Promise<void> {
    if (this.free > 0) {
      this.free--;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.free++;
  }
}

export function createBridge(deps: BridgeDeps): BridgeFn {
  const { pool, policy, emit, scriptId } = deps;
  // The script sees sanitised identifiers; the servers know the real names.
  const byIdentifier = new Map<string, CatalogTool>();
  for (const t of deps.catalog) byIdentifier.set(`${toIdentifier(t.server)}.${toIdentifier(t.name)}`, t);

  const semaphore = new Semaphore(policy.maxConcurrency);
  const perTool = new Map<string, number>();
  let total = 0;
  let seq = 0;

  return async (server, toolName, args) => {
    const tool = byIdentifier.get(`${server}.${toolName}`);
    if (!tool) throw new Error(`tool not found: ${server}.${toolName}`);

    const callId = `${scriptId}-${++seq}`;
    const started = Date.now();
    emit({ type: 'call_started', scriptId, callId, server: tool.server, tool: tool.name, args, at: started });
    const finish = (extra: { ok: boolean; denied?: boolean; error?: string; bytes?: number }): void =>
      emit({
        type: 'call_finished',
        scriptId,
        callId,
        ok: extra.ok,
        ...(extra.denied && { denied: true }),
        ...(extra.error !== undefined && { error: extra.error }),
        bytes: extra.bytes ?? 0,
        durationMs: Date.now() - started,
      });

    const decision = decide(tool, policy);
    if (!decision.allow) {
      finish({ ok: false, denied: true, error: decision.reason });
      throw new ToolDeniedError(decision.reason);
    }

    const key = `${tool.server}.${tool.name}`;
    const used = perTool.get(key) ?? 0;
    if (total >= policy.maxCalls || used >= policy.maxCallsPerTool) {
      const message =
        total >= policy.maxCalls
          ? `call budget exhausted: a script may make at most ${policy.maxCalls} tool calls`
          : `call budget exhausted for ${key}: at most ${policy.maxCallsPerTool} calls per script`;
      finish({ ok: false, error: message });
      throw new Error(message);
    }
    total++;
    perTool.set(key, used + 1);

    await semaphore.acquire();
    try {
      const result = await pool.call(tool.server, tool.name, args);
      finish({ ok: true, bytes: Buffer.byteLength(JSON.stringify(result) ?? 'null', 'utf8') });
      return result;
    } catch (err: unknown) {
      finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      semaphore.release();
    }
  };
}
