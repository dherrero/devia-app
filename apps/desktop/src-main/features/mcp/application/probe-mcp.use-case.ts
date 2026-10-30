import { spawn } from 'node:child_process';

import type { McpProbeResult, McpServerConfig } from '../../../../shared/domain/mcp';
import { createCommandInvocation } from '../../cli-adapters/infrastructure/spawn-invocation';
import { resolveOnPath } from '../../cli-adapters/infrastructure/detection/path-resolver';
import { composeServerEnv } from '../infrastructure/temp-config-writer';

/**
 * Health-probes an MCP server by spawning it, sending a single MCP
 * `initialize` request over stdio, and parsing the response (#273).
 *
 * Best-effort, capped at 5 s. The server's first stdout line must be
 * a JSON-RPC response with the matching `id`; anything else is a
 * failure. We do NOT keep the server alive — it gets SIGTERM'd
 * immediately after the response (or the timeout).
 *
 * No external MCP SDK dependency — the protocol envelope is small
 * enough that a hand-rolled JSON-RPC frame keeps us free of new deps.
 */
const PROBE_TIMEOUT_MS = 5_000;

interface InitializeResponse {
  jsonrpc?: string;
  id?: number;
  result?: {
    serverInfo?: { name?: string; version?: string };
  };
  error?: { code?: number; message?: string };
}

export class ProbeMcpUseCase {
  async execute(server: McpServerConfig): Promise<McpProbeResult> {
    const env = composeServerEnv(server, process.env);
    const invocation = createMcpProbeInvocation(server, env);
    return new Promise<McpProbeResult>((resolve) => {
      let stderrBuf = '';
      let stdoutBuf = '';
      let resolved = false;
      let child;
      try {
        child = spawn(invocation.command, invocation.args, {
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
          windowsVerbatimArguments: invocation.windowsVerbatimArguments,
        });
      } catch (err) {
        resolve({ ok: false, error: (err as Error).message });
        return;
      }

      const finish = (result: McpProbeResult): void => {
        if (resolved) return;
        resolved = true;
        try { child.kill('SIGTERM'); } catch { /* swallow */ }
        // Hard-kill after 200 ms in case SIGTERM is ignored.
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* swallow */ } }, 200);
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          ok: false,
          error: `Probe timeout after ${PROBE_TIMEOUT_MS}ms`,
          stderr: capStderr(stderrBuf),
        });
      }, PROBE_TIMEOUT_MS);

      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, error: err.message });
      });

      child.on('exit', (code) => {
        // Premature exit before responding — treat as failure with
        // whatever stderr captured.
        clearTimeout(timer);
        if (resolved) return;
        finish({
          ok: false,
          ...(typeof code === 'number' && { code }),
          stderr: capStderr(stderrBuf),
          error: `Server exited (code=${code ?? 'null'}) before responding`,
        });
      });

      child.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf8');
      });

      child.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf8');
        // MCP frames are one JSON object per line. Try the first line
        // as soon as we have a newline; subsequent output is ignored.
        const newline = stdoutBuf.indexOf('\n');
        if (newline === -1) return;
        const line = stdoutBuf.slice(0, newline);
        let parsed: InitializeResponse | null = null;
        try { parsed = JSON.parse(line) as InitializeResponse; }
        catch { /* keep waiting — sometimes servers print banners */ }
        if (!parsed) return;
        if (parsed.error) {
          clearTimeout(timer);
          finish({
            ok: false,
            error: parsed.error.message ?? 'MCP error',
            stderr: capStderr(stderrBuf),
          });
          return;
        }
        if (parsed.result) {
          clearTimeout(timer);
          finish({
            ok: true,
            ...(parsed.result.serverInfo?.version !== undefined && {
              version: parsed.result.serverInfo.version,
            }),
          });
        }
      });

      const request = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'devia-probe', version: '1.0.0' },
        },
      }) + '\n';
      try { child.stdin?.write(request); child.stdin?.end(); } catch { /* swallow */ }
    });
  }
}

export function createMcpProbeInvocation(
  server: McpServerConfig,
  env: NodeJS.ProcessEnv,
) {
  const resolvedCommand = resolveOnPath(server.command) ?? server.command;
  return createCommandInvocation({
    command: resolvedCommand,
    args: server.args,
    env,
  });
}

function capStderr(s: string): string {
  return s.length > 1024 ? s.slice(-1024) : s;
}
