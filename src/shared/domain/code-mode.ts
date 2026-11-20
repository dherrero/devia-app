/**
 * Events the `devia-code-mode` gateway publishes for every script it runs (S-50).
 * The gateway is a child of the agent, so it writes them to a JSONL file in a
 * rendezvous directory; the main process reads them and shows each internal call
 * as a nested tool call under the `run_script` card.
 */
export type CodeModeEvent =
  | {
      type: 'call_started';
      scriptId: string;
      callId: string;
      server: string;
      tool: string;
      args: unknown;
      at: number;
    }
  | {
      type: 'call_finished';
      scriptId: string;
      callId: string;
      ok: boolean;
      /** The policy refused the call (distinct from the tool itself failing). */
      denied?: boolean;
      error?: string;
      /** Serialized size of the response. */
      bytes: number;
      durationMs: number;
    }
  | {
      type: 'script_finished';
      scriptId: string;
      ok: boolean;
      callCount: number;
      /** Bytes the tools returned to the script. */
      bytesFetched: number;
      /** Bytes the script handed back to the agent. */
      bytesReturned: number;
      durationMs: number;
    };
