import { randomUUID } from 'node:crypto';
import * as readline from 'node:readline';

import { DEFAULT_UI_TIMEOUT_MS } from '../../../shared/ui-rendezvous';
import { UI_TOOL_NAMES, type UiToolName } from '../../../../shared/domain/ui-tools';
import { makeSendFileResolver } from './send-file-resolver';
import { makeSkillResolver } from './skill-reader';
import { parseToolList } from './tool-registry';
import { createUiDispatcher, type JsonRpcMessage } from './ui-server';
import type { UiLocalResolution } from './ui-tools-call';

/**
 * devia-ui — standalone MCP server (S-25, generalises the S-24 `devia-ask`).
 *
 * Spawned by the active CLI agent (its MCP client) over stdio. Speaks minimal
 * JSON-RPC 2.0 with newline-delimited framing — no SDK dependency, mirroring
 * the bundled `devia-memory` server.
 *
 * Invocation (baked into the per-run MCP config):
 *   node <...>/server.js --ui-dir <rendezvous dir for this run> --tools a,b,c
 *     [--skills-dir <dir>]... [--subagents-dir <dir>]
 *     [--send-roots <json array of abs paths> --cwd <abs>
 *      --deny-roots <json array of abs paths>]               (only with send_file)
 *
 * The user's answer arrives out-of-band: the main process polls the rendezvous
 * directory, draws the card, and writes the answer file back.
 */

interface Args {
  uiDir: string;
  tools: UiToolName[];
  /** Repeatable: every directory Devia manages skills in (S-30 T-356). */
  skillsDirs: string[];
  /** Devia's sub-agent definitions (`.devia/sub-agents`), when any. */
  subagentsDir: string | null;
  /** `devia_send_file` (S-32): folders a file may be sent from. */
  sendRoots: string[];
  /** Folders nothing may be sent from even inside a root (Devia's data dir). */
  denyRoots: string[];
  /** The run's cwd — explicit because pi/OpenCode may spawn us elsewhere. */
  cwd: string | null;
}

function parseRoots(raw: string | undefined): string[] {
  try {
    const parsed: unknown = JSON.parse(raw ?? '');
    return Array.isArray(parsed) ? parsed.filter((r): r is string => typeof r === 'string' && r.length > 0) : [];
  } catch {
    return [];
  }
}

function parseArgs(argv: string[]): Args {
  let uiDir = '';
  const skillsDirs: string[] = [];
  let subagentsDir: string | null = null;
  let sendRoots: string[] = [];
  let denyRoots: string[] = [];
  let cwd: string | null = null;
  // `--tools` absent means "everything": a hand-written config (or an older
  // injector) should still get a working server rather than a mute one.
  let tools: UiToolName[] = [...UI_TOOL_NAMES];
  for (let i = 0; i < argv.length; i++) {
    // `--ask-dir` is the S-24 flag name, kept so a stale native MCP config
    // written by a previous build still starts a working server.
    if (argv[i] === '--ui-dir' || argv[i] === '--ask-dir') uiDir = argv[++i] ?? '';
    else if (argv[i] === '--tools') tools = parseToolList(argv[++i] ?? '');
    else if (argv[i] === '--skills-dir') {
      const dir = argv[++i];
      if (dir) skillsDirs.push(dir);
    } else if (argv[i] === '--subagents-dir') subagentsDir = argv[++i] ?? null;
    else if (argv[i] === '--send-roots') sendRoots = parseRoots(argv[++i]);
    else if (argv[i] === '--deny-roots') denyRoots = parseRoots(argv[++i]);
    else if (argv[i] === '--cwd') cwd = argv[++i] || null;
  }
  return { uiDir, tools, skillsDirs, subagentsDir, sendRoots, denyRoots, cwd };
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function main(): void {
  const { uiDir, tools, skillsDirs, subagentsDir, sendRoots, denyRoots, cwd } = parseArgs(process.argv.slice(2));

  if (!uiDir) {
    process.stderr.write('[devia-ui] missing --ui-dir\n');
    process.exit(2);
    return;
  }

  const timeoutMs = parsePositiveInt(
    process.env['DEVIA_UI_TOOL_TIMEOUT_MS'] ?? process.env['DEVIA_ASK_USER_QUESTION_TIMEOUT_MS'],
    DEFAULT_UI_TIMEOUT_MS,
  );

  const resolvers = [
    makeSkillResolver(skillsDirs, subagentsDir),
    makeSendFileResolver({ cwd, roots: sendRoots, denyRoots }),
  ];
  const handle = createUiDispatcher(
    {
      uiDir,
      timeoutMs,
      advertised: tools,
      newCallId: (): string => `ui-${randomUUID()}`,
      // `skill` (skills + sub-agents) never reaches the rendezvous: a read-only
      // file lookup that needs nothing from the main process. `send_file` is
      // validated here and then forwarded, enriched.
      resolveLocally: async (tool, args): Promise<UiLocalResolution> => {
        for (const resolve of resolvers) {
          const result = await resolve(tool, args);
          if (result) return result;
        }
        return null;
      },
    },
    (msg: object) => {
      process.stdout.write(`${JSON.stringify(msg)}\n`);
    },
  );

  const rl = readline.createInterface({ input: process.stdin });
  rl.on('line', (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      return; // malformed line — skip
    }
    // Not awaited on purpose: a `tools/call` can stay pending for minutes while
    // the user decides, and the server has to keep answering everything else.
    void handle(msg);
  });
  rl.on('close', () => process.exit(0));
}

main();
