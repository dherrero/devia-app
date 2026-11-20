import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AgentEvent } from '../../../../shared/domain/agent-event';
import { CODE_MODE_DENIED_PREFIX, type CodeModeEvent } from '../../../../shared/domain/code-mode';

/**
 * Turns what the `devia-code-mode` gateway publishes into nested tool calls in the
 * chat (S-50). The gateway is a child of the agent and cannot call the main
 * process, so it appends `CodeModeEvent`s to `<eventsDir>/<scriptId>.jsonl` (the
 * same file-rendezvous idea as `devia-ui`); this reads them and emits ordinary
 * `tool_use` / `tool_result` events whose `parentToolUseId` is the agent's own
 * `run_script` call, which is how S-49 already nests a sub-agent's calls.
 *
 * Matching a script to its `run_script` call is by a hash of the code, so two
 * scripts running at once each land under their own card.
 */

const POLL_MS = 150;
/** How long a script may wait for its `run_script` tool call before being paired by order. */
const PAIR_BY_ORDER_AFTER_MS = 1500;

/** `mcp__devia-code-mode__run_script`, `mcp__devia_code_mode__run_script`, `devia-code-mode.run_script`, `run_script`. */
const RUN_SCRIPT_NAME = /(?:code[-_]mode.*run_script|^run_script)$/;

const codeHash = (code: string): string => crypto.createHash('sha256').update(code).digest('hex').slice(0, 16);

interface OpenRunScript {
  toolUseId: string;
  hash: string;
  used: boolean;
}

interface ScriptState {
  offset: number;
  partial: string;
  firstSeen: number;
  hash?: string;
  parent?: string;
  /** Events read before the script could be matched to its tool call. */
  held: CodeModeEvent[];
}

export interface CodeModeEventRelayOptions {
  eventsDir: string;
  emit: (event: AgentEvent) => void;
}

export class CodeModeEventRelay {
  private readonly scripts = new Map<string, ScriptState>();
  private readonly openRunScripts: OpenRunScript[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: CodeModeEventRelayOptions) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), POLL_MS);
    this.timer.unref();
  }

  /** Last read, then pairs by order whatever is still unmatched. Safe to call twice. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush(true);
  }

  /** Feed every event the agent emits: the `run_script` tool calls are what the scripts hang from. */
  observeAgentEvent(event: AgentEvent): void {
    if (event.type !== 'tool_use' || !RUN_SCRIPT_NAME.test(event.name)) return;
    const input = event.input;
    const code = typeof input === 'object' && input !== null ? (input as { code?: unknown }).code : undefined;
    if (typeof code !== 'string') return;
    this.openRunScripts.push({ toolUseId: event.id, hash: codeHash(code), used: false });
    this.matchHeld(false);
  }

  /** Reads whatever was appended since the last call. `force` pairs leftovers by order. */
  flush(force = false): void {
    for (const scriptId of this.listScripts()) {
      let state = this.scripts.get(scriptId);
      if (!state) {
        state = { offset: 0, partial: '', firstSeen: Date.now(), held: [] };
        this.scripts.set(scriptId, state);
      }
      for (const event of this.readNew(scriptId, state)) this.handle(state, event);
    }
    this.matchHeld(force);
  }

  private listScripts(): string[] {
    try {
      return fs
        .readdirSync(this.opts.eventsDir)
        .filter((f) => f.endsWith('.jsonl'))
        .map((f) => f.slice(0, -'.jsonl'.length))
        .sort();
    } catch {
      return []; // the gateway has not published anything yet
    }
  }

  private readNew(scriptId: string, state: ScriptState): CodeModeEvent[] {
    const file = path.join(this.opts.eventsDir, `${scriptId}.jsonl`);
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }
    if (size <= state.offset) return [];
    const buf = Buffer.alloc(size - state.offset);
    const fd = fs.openSync(file, 'r');
    try {
      fs.readSync(fd, buf, 0, buf.length, state.offset);
    } finally {
      fs.closeSync(fd);
    }
    state.offset = size;
    const lines = (state.partial + buf.toString('utf8')).split('\n');
    state.partial = lines.pop() ?? ''; // a line without its newline is still being written
    const events: CodeModeEvent[] = [];
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as CodeModeEvent);
      } catch {
        // A torn or foreign line is not worth breaking the timeline for.
      }
    }
    return events;
  }

  private handle(state: ScriptState, event: CodeModeEvent): void {
    if (event.type === 'script_started') {
      state.hash = event.codeHash;
      this.tryMatchByHash(state);
      return;
    }
    if (state.parent === undefined) state.held.push(event);
    else this.emitEvent(event, state.parent);
  }

  private tryMatchByHash(state: ScriptState): void {
    if (state.parent !== undefined || state.hash === undefined) return;
    const open = this.openRunScripts.find((o) => !o.used && o.hash === state.hash);
    if (open) this.adopt(state, open);
  }

  private matchHeld(force: boolean): void {
    const now = Date.now();
    const waiting = [...this.scripts.values()].filter((s) => s.parent === undefined);
    for (const state of waiting) this.tryMatchByHash(state);
    // The agent may have rewritten the code on its way (so the hashes differ): pair
    // what is still unmatched with the open calls, oldest first, once it is clear
    // the exact match is not coming.
    for (const state of waiting.filter((s) => s.parent === undefined)) {
      if (!force && now - state.firstSeen < PAIR_BY_ORDER_AFTER_MS) continue;
      const open = this.openRunScripts.find((o) => !o.used);
      if (open) this.adopt(state, open);
    }
  }

  private adopt(state: ScriptState, open: OpenRunScript): void {
    open.used = true;
    state.parent = open.toolUseId;
    for (const event of state.held.splice(0)) this.emitEvent(event, open.toolUseId);
  }

  private emitEvent(event: CodeModeEvent, parentToolUseId: string): void {
    if (event.type === 'call_started') {
      this.opts.emit({
        type: 'tool_use',
        id: event.callId,
        name: `${event.server}.${event.tool}`,
        input: event.args,
        parentToolUseId,
      });
    } else if (event.type === 'call_finished') {
      const content = event.denied
        ? `${CODE_MODE_DENIED_PREFIX}${event.error ?? 'denied'}`
        : event.ok
          ? `${event.bytes} bytes`
          : event.error ?? 'failed';
      this.opts.emit({ type: 'tool_result', toolUseId: event.callId, content, isError: !event.ok });
    }
    // `script_finished` is not shown as an event: its figures are in the JSON the
    // `run_script` call itself returns, which is what the card reads.
  }
}
