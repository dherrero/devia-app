#!/usr/bin/env node
'use strict';
/**
 * Agent E2E harness (S-30 T-344). Drives REAL CLI agents through Devia's real
 * run pipeline and compares what happened against committed snapshots.
 *
 *   node tools/agent-e2e/run.cjs <claude|pi|opencode|acp-fake|all> [--update] [--record]
 *
 *   --update  rewrite snapshots/<agent>-<scenario>.json from this run
 *   --record  copy each run's raw stdout into
 *             src/main/features/agents/<agent>/__fixtures__/<scenario>.jsonl
 *
 * Requires `npm run build:main` first. Uses real models (cost!) and
 * never runs in CI. See README.md.
 *
 * The snapshot has two halves:
 *   - `wiring`    what reached the CLI (argv, stdin shape, MCP servers in the
 *                 files the argv points at or the native config, system-prompt
 *                 channel). Deterministic: a mismatch FAILS the run.
 *   - `behaviour` what the model did with it (Devia tools called, cards drawn,
 *                 continuity recalled, file written in plan mode). The model is
 *                 not deterministic: a mismatch only WARNS (re-run to confirm).
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildHeadlessRun, buildFakeAcpAgent } = require('./headless.cjs');
const { SCENARIOS, ANSWER, HARNESS_TOKENS } = require('./scenarios.cjs');

const APP_ROOT = path.resolve(__dirname, '../..');
const SNAP_DIR = path.join(__dirname, 'snapshots');
const RAW_LOG_ROOT = path.join(os.homedir(), '.devia-app', 'logs', 'agent-cli');
const RUN_TIMEOUT_MS = 6 * 60 * 1000;

/**
 * Per-agent run options. Claude uses haiku to keep the cost low. OpenCode's
 * default free model (`opencode/big-pickle`) stalls mid-turn on tool-heavy
 * prompts; the deepseek flash free model finishes reliably.
 */
const AGENTS = {
  claude: { model: 'haiku' },
  pi: {},
  opencode: { model: 'opencode/deepseek-v4.1-flash-free' },
  // Still on LegacyMapper (S-30 T-354): live check that phase 1 kept them
  // working. grok is deliberately absent — its MCP config is GLOBAL
  // (~/.grok/user-settings.json), so a harness run would write the
  // developer's real file.
  codex: {},
  gemini: {},
  // S-41: real ACP agents through the AcpMapper (need the CLI installed and
  // authenticated; the first run writes the snapshots, `--update` accepts a new one).
  kimi: {},
  hermes: {},
  // S-41: a scripted ACP agent (free, deterministic) that exercises the AcpMapper
  // through the real pipeline. Only for this harness, never in the catalog.
  'acp-fake': { fake: true, answer: 'Allow' },
};

/** What the fake ACP agent does in each scenario (a FakeAcpScript, see agents/acp/testing). */
const FAKE_SCRIPTS = {
  apply: {
    modes: [{ id: 'default' }, { id: 'plan' }],
    turns: [{ steps: [
      { type: 'tool', id: 'todo', title: 'devia-ui_devia_todo', kind: 'other', output: 'ok' },
      { type: 'permission', toolId: 'w1', title: 'Write notes.txt', kind: 'edit', announce: true },
      { type: 'tool', id: 'w1', title: 'Write notes.txt', kind: 'edit', output: 'written' },
      { type: 'tool', id: 'mem', title: 'devia-memory_mem_save', kind: 'other', output: 'saved' },
      { type: 'tool', id: 'spec', title: 'devia-kanban_kanban_create_spec', kind: 'other', output: 'S-1' },
      { type: 'text', text: 'Done: todo, permission, memory and spec.' },
    ] }],
  },
  resume: {
    modes: [{ id: 'default' }, { id: 'plan' }],
    history: [
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'earlier question' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'earlier answer' } },
    ],
    turns: [{ steps: [{ type: 'text', text: 'Verde' }] }],
  },
  plan: {
    modes: [{ id: 'default' }, { id: 'plan' }],
    turns: [{ steps: [
      { type: 'permission', toolId: 'w1', title: 'Write notas.txt', kind: 'edit' },
      { type: 'tool', id: 'w1', title: 'Write notas.txt', kind: 'edit' },
      { type: 'tool', id: 'list', title: 'devia-kanban_kanban_list_specs', kind: 'other', output: '[]' },
      { type: 'text', text: 'I could not create the file; there are no specs.' },
    ] }],
  },
  harness: {
    modes: [{ id: 'default' }, { id: 'plan' }],
    turns: [{ steps: [
      { type: 'tool', id: 'echo', title: 'e2e-echo_echo_token', kind: 'other', output: 'ECHO-7Q4Z' },
      { type: 'text', text: 'ECHO-7Q4Z\nSKILL-3K9P\nROLE-8M2X' },
    ] }],
  },
};

/** An executable that runs the scripted ACP agent, so the launcher spawns a real child. */
function writeFakeAcpLauncher(root) {
  const cli = path.join(APP_ROOT, 'src/main/features/agents/acp/testing/fake-acp-agent.cli.cjs');
  const bin = path.join(root, 'acp-fake');
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`, { mode: 0o755 });
  return bin;
}

// ── spawn interception ─────────────────────────────────────────────────────

/** Every agent spawn of the current run: command, args, cwd, stdin writes, and
 *  a snapshot of the files the argv references (they are temp files deleted
 *  when the run ends, so they must be read at spawn time). */
let spawnLog = [];
let workspaceRoot = '';
const realSpawn = childProcess.spawn;
childProcess.spawn = function patchedSpawn(command, args, options) {
  const child = realSpawn.call(this, command, args, options);
  const cwd = options && options.cwd ? String(options.cwd) : '';
  if (workspaceRoot && cwd.startsWith(workspaceRoot)) {
    const envFiles = ['OPENCODE_CONFIG'].map((k) => options?.env?.[k]).filter(Boolean);
    const entry = {
      command, args: [...(args || [])], cwd, stdin: [],
      files: readReferencedFiles([...(args || []), ...envFiles], cwd),
      // Per-run configs some CLIs take from the env (OpenCode).
      configEnv: Object.fromEntries(['OPENCODE_CONFIG'].filter((k) => options?.env?.[k]).map((k) => [k, true])),
    };
    spawnLog.push(entry);
    if (child.stdin) {
      const write = child.stdin.write.bind(child.stdin);
      child.stdin.write = (chunk, ...rest) => {
        entry.stdin.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return write(chunk, ...rest);
      };
    }
  }
  return child;
};

function readReferencedFiles(args, cwd) {
  const files = {};
  const readIfFile = (p) => {
    try {
      if (path.isAbsolute(p) && fs.statSync(p).isFile()) files[p] = fs.readFileSync(p, 'utf8');
    } catch { /* not a file */ }
  };
  args.forEach((a) => readIfFile(a));
  // Native configs the CLI will read from its cwd.
  for (const rel of ['opencode.json', '.pi/mcp.json', '.mcp.json']) readIfFile(path.join(cwd, rel));
  return files;
}

// ── normalisation ──────────────────────────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizer(ctx) {
  const tmpRoots = [os.tmpdir(), fs.realpathSync(os.tmpdir()), '/tmp', '/private/tmp']
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
  return (s) => {
    let out = String(s);
    out = out.split(ctx.deviaDir).join('<DEVIA>');
    out = out.split(ctx.workspaceRoot).join('<WS>');
    out = out.split(APP_ROOT).join('<APP>');
    // Only a tmp root at the START of a path: `<DEVIA>/tmp/...` keeps its `/tmp`.
    for (const t of tmpRoots) out = out.replace(new RegExp(`(^|[\\s"'=:])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '$1<TMP>');
    out = out.split(os.homedir()).join('~');
    out = out.replace(/<DEVIA>\/kits\/devia-method\/v[^/\s"']+/g, '<DEVIA>/kits/devia-method/<VERSION>');
    out = out.replace(UUID, '<UUID>');
    out = out.replace(/\bses_[A-Za-z0-9]+/g, '<SESSION>');
    out = out.replace(/<TMP>\/devia-system-prompt-[^\s"]+/g, '<TMP>/devia-system-prompt-<RUN>.md');
    out = out.replace(/pi-mcp-<UUID>\.mjs/g, 'pi-mcp-<ID>.mjs');
    out = out.replace(/mcp-<UUID>\.json/g, 'mcp-<ID>.json');
    out = out.replace(/devia-ui\/[^\s"',]+/g, 'devia-ui/<RUN>');
    return out;
  };
}

/** argv with long free-text values (system prompt, prompt) collapsed. */
function normalizeArgv(args, norm) {
  return args.map((a) => (a.length > 300 ? `<TEXT>` : norm(a)));
}

/** Server ids delivered through any file the argv references or the native config. */
function deliveredServers(spawn) {
  const ids = new Set();
  for (const [file, content] of Object.entries(spawn.files)) {
    if (file.endsWith('.json')) {
      try {
        const parsed = JSON.parse(content);
        for (const key of ['mcpServers', 'mcp']) {
          if (parsed[key] && typeof parsed[key] === 'object') Object.keys(parsed[key]).forEach((k) => ids.add(k));
        }
      } catch { /* not JSON */ }
    } else if (file.endsWith('.mjs')) {
      const m = /const SERVERS = (\{[\s\S]*?\n\});/.exec(content);
      if (m) Object.keys(JSON.parse(m[1])).forEach((k) => ids.add(k));
    }
  }
  for (const req of jsonRpcRequests(spawn)) {
    if (req.method === 'session/new' || req.method === 'session/load') (req.params?.mcpServers ?? []).forEach((s) => ids.add(s.name));
  }
  return [...ids].sort();
}

function systemPromptChannel(spawn) {
  const i = spawn.args.indexOf('--append-system-prompt');
  if (i >= 0) {
    const v = spawn.args[i + 1] || '';
    return spawn.files[v] !== undefined ? 'argv-file' : 'argv';
  }
  const stdin = acpPromptText(spawn) ?? spawn.stdin.join('');
  if (stdin.includes('[System]')) return 'stdin-prepend';
  return 'none';
}

/**
 * S-40: Devia's per-turn context block, when the CLI got one as the first content
 * block of its stream-json user message. Empty otherwise.
 */
function turnContextBlock(spawn) {
  for (const line of spawn.stdin.join('').split('\n')) {
    try {
      const content = JSON.parse(line)?.message?.content;
      if (!Array.isArray(content)) continue;
      const block = content.map((b) => b?.text).find((t) => typeof t === 'string' && t.startsWith('<devia-turn-context'));
      if (block) return block;
    } catch { /* not a JSON line */ }
  }
  return '';
}

/**
 * What the model is told as its system prompt. For a CLI that keeps its first
 * turn's prompt (Claude, S-40) the per-turn block is part of it, so the facts the
 * snapshots pin do not depend on which channel carries each sentence.
 */
function systemPromptText(spawn, withBlock = true) {
  const i = spawn.args.indexOf('--append-system-prompt');
  if (i >= 0) {
    const v = spawn.args[i + 1] || '';
    const text = spawn.files[v] ?? v;
    const block = withBlock ? turnContextBlock(spawn) : '';
    return block ? `${text}\n\n${block}` : text;
  }
  const stdin = acpPromptText(spawn) ?? spawn.stdin.join('');
  const m = /\[System\]\n([\s\S]*?)\n\n\[User\]/.exec(stdin);
  return m ? m[1] : '';
}

/** What `devia-ui` was told to serve: skill roots and the sub-agents dir. */
function uiServerFacts(spawn) {
  for (const [file, content] of Object.entries(spawn.files)) {
    let args = null;
    if (file.endsWith('.json')) {
      try {
        const parsed = JSON.parse(content);
        const entry = (parsed.mcpServers ?? parsed.mcp ?? {})['devia-ui'];
        if (entry) args = entry.args ?? entry.command ?? null;
      } catch { /* not JSON */ }
    } else if (file.endsWith('.mjs')) {
      const m = /const SERVERS = (\{[\s\S]*?\n\});/.exec(content);
      if (m) args = JSON.parse(m[1])['devia-ui']?.args ?? null;
    }
    if (args) {
      return {
        skillsDirs: args.filter((a, i) => args[i - 1] === '--skills-dir').length,
        subagentsDir: args.includes('--subagents-dir'),
      };
    }
  }
  return null;
}

/** The JSON-RPC requests the client wrote to an ACP child (S-41), in order. */
function jsonRpcRequests(spawn) {
  const out = [];
  for (const line of spawn.stdin.join('').split('\n')) {
    try {
      const msg = JSON.parse(line);
      if (msg && msg.jsonrpc === '2.0' && typeof msg.method === 'string') out.push(msg);
    } catch { /* not a JSON line */ }
  }
  return out;
}

/** The text of the first session/prompt block, when this spawn is an ACP session. */
function acpPromptText(spawn) {
  const prompt = jsonRpcRequests(spawn).find((m) => m.method === 'session/prompt');
  const block = prompt?.params?.prompt?.find((b) => b.type === 'text');
  return typeof block?.text === 'string' ? block.text : null;
}

/** What reached an ACP agent through its protocol: facts only an AcpMapper run has. */
function acpFacts(spawn, norm) {
  const requests = jsonRpcRequests(spawn);
  if (requests.length === 0) return null;
  const session = requests.find((m) => m.method === 'session/new' || m.method === 'session/load');
  const init = requests.find((m) => m.method === 'initialize');
  return {
    methods: requests.map((m) => m.method).filter((m, i, all) => all.indexOf(m) === i),
    loadedSession: requests.some((m) => m.method === 'session/load'),
    mcpServers: (session?.params?.mcpServers ?? []).map((s) => s.name).sort(),
    mode: requests.filter((m) => m.method === 'session/set_mode').map((m) => m.params.modeId),
    clientCapabilities: init?.params?.clientCapabilities ?? null,
    cwd: norm(session?.params?.cwd ?? ''),
    systemPromptSeen: /^\[System\]/.test(acpPromptText(spawn) ?? ''),
  };
}

function stdinShape(spawn) {
  const raw = spawn.stdin.join('');
  if (!raw) return { format: 'none' };
  const lines = raw.split('\n').filter((l) => l.trim());
  const json = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  if (json.every((j) => j && j.jsonrpc === '2.0')) {
    return { format: 'jsonrpc', methods: [...new Set(json.map((j) => j.method).filter((m) => typeof m === 'string'))] };
  }
  if (json.every((j) => j && typeof j === 'object')) {
    return { format: 'jsonl', types: [...new Set(json.map((j) => j.type))].sort() };
  }
  return { format: 'text', systemHeader: raw.startsWith('[System]') };
}

/** Facts about the system prompt that must survive any refactor. */
function systemPromptFacts(text, kit = false, turn = null) {
  return {
    announcesUiTools: /devia_ask_user/.test(text),
    announcesMemory: /mem_save|mem_search/.test(text),
    mentionsKanban: /kanban/i.test(text),
    // Only in the kit scenario, so the baselines of the others stay untouched.
    ...(kit && {
      kitPrompt: /## Devia Method/.test(text),
      kitIndex: /## Skills/.test(text) && /`brainstorming`/.test(text),
    }),
    // Only in the origin scenarios (S-40): which channel the block declared, and
    // whether the argv prompt still carries a stale Telegram claim.
    ...(turn && {
      turnContext: {
        delivered: turn.block !== '',
        channel: /- Channel: Telegram/.test(turn.block) ? 'telegram' : /- Channel: Devia desktop app/.test(turn.block) ? 'desktop' : null,
        staleRemoteInArgvPrompt: /Remote session — Telegram/.test(turn.argvText),
      },
    }),
  };
}

// ── run one scenario ───────────────────────────────────────────────────────

function runScenario(ctx, scenario) {
  return new Promise((resolve) => {
    spawnLog = [];
    const events = [];
    const ui = [];
    let runId = '';
    let finished = false;
    const done = (end) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Give the process a moment to flush and remove its temp files.
      setTimeout(() => resolve({ events, ui, end, runId, spawns: spawnLog }), 300);
    };
    const timer = setTimeout(() => {
      ctx.registry.cancelRun?.(runId, 'user');
      done({ code: null, error: 'harness timeout' });
    }, RUN_TIMEOUT_MS);

    const fallback = ctx.answer ?? ANSWER;
    const answer = (callId, content) =>
      setTimeout(() => ctx.registry.writeToolResult(ctx.project, callId, content), 150);

    ctx.useCase.execute(ctx.project, scenario.prompt, [], {
      onProcessStart: (p) => { runId = p.runId; },
      onClaudeOutput: (line) => { try { events.push(JSON.parse(line)); } catch { /* raw */ } },
      onProcessEnd: (p) => done({ code: p.code, error: p.error }),
      onOutboxFile: () => {},
      onQuestionAsk: (toolUseId) => { ui.push('ask_user'); answer(toolUseId, scenario.answer ?? fallback); },
      onUiToolRequest: (callId, tool, _input, _runId, expectsAnswer) => {
        ui.push(tool);
        if (expectsAnswer) answer(callId, tool === 'confirm' ? 'yes' : (scenario.answer ?? fallback));
      },
    }, scenario.mode, [], scenario.origin ?? 'renderer');
  });
}

/** The JSON the `origin-*` scenarios ask for: what the model says its channel is (S-40). */
function originAnswer(text) {
  const m = /\{[^{}]*\}/.exec(text);
  try {
    const parsed = m ? JSON.parse(m[0]) : {};
    return { saidChannel: parsed.channel ?? null, saidCards: parsed.cards ?? null };
  } catch {
    return { saidChannel: null, saidCards: null };
  }
}

function buildSnapshot(ctx, agent, scenario, result) {
  const norm = normalizer(ctx);
  const spawn = result.spawns[0];
  const finalText = result.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  const deviaTools = [...new Set(result.events
    .filter((e) => e.type === 'tool_use' && /^mcp__devia-/.test(e.name))
    .map((e) => e.name))].sort();
  const wiring = spawn
    ? {
        command: path.basename(spawn.command),
        argv: normalizeArgv(spawn.args, norm),
        stdin: stdinShape(spawn),
        mcpServers: deliveredServers(spawn),
        systemPrompt: {
          channel: systemPromptChannel(spawn),
          ...systemPromptFacts(
            systemPromptText(spawn),
            scenario.kit === true,
            scenario.origin !== undefined ? { block: turnContextBlock(spawn), argvText: systemPromptText(spawn, false) } : null,
          ),
        },
        uiServer: uiServerFacts(spawn),
        ...(acpFacts(spawn, norm) && { acp: acpFacts(spawn, norm) }),
        ...(Object.keys(spawn.configEnv).length > 0 && { configEnv: spawn.configEnv }),
      }
    : { spawned: false };
  const behaviour = {
    exitCode: result.end.code,
    eventTypes: [...new Set(result.events.map((e) => e.type))].sort(),
    sessionStarted: result.events.some((e) => e.type === 'session_started'),
    deviaTools,
    uiCards: [...new Set(result.ui)].sort(),
    ...(scenario.id === 'resume' && { recalled: finalText.includes(ANSWER) }),
    ...(scenario.origin !== undefined && originAnswer(finalText)),
    ...(scenario.id === 'plan' && { wroteFile: fs.existsSync(path.join(ctx.projectDir, 'notas.txt')) }),
    ...(scenario.kit && kitBehaviour(ctx, result, finalText)),
    ...(scenario.harness && {
      quoted: Object.fromEntries(Object.entries(HARNESS_TOKENS).map(([k, token]) => [k, finalText.includes(token)])),
    }),
  };
  return { agent, scenario: scenario.id, wiring, behaviour };
}

/**
 * S-38: did the method kick in before anything was built? `loadedSkill` looks
 * for the brainstorming skill being loaded by any route (Claude's Skill tool,
 * `devia_skill`, or a plain read of its SKILL.md); `wroteCode` is whether the
 * project holds anything but the git repo.
 */
function kitBehaviour(ctx, result, finalText) {
  const uses = result.events.filter((e) => e.type === 'tool_use');
  const loadedSkill = uses.some((e) => /brainstorming/.test(JSON.stringify(e.input ?? e.arguments ?? e.args ?? e)));
  const entries = fs.readdirSync(ctx.projectDir).filter((n) => !['.git', '.gitignore', '.claude', '.devia', '.mcp.json', '.pi', '.codex', '.gemini', 'opencode.json'].includes(n));
  return {
    loadedSkill,
    askedBeforeBuilding: result.ui.includes('ask_user') || /\?/.test(finalText),
    wroteCode: entries.length > 0,
    ...(process.env.E2E_DEBUG && { debug: { entries, tools: uses.map((e) => e.name), text: finalText.slice(0, 700) } }),
    usedKanban: uses.some((e) => /kanban_create_(spec|task)/.test(e.name)),
  };
}

/**
 * S-30 T-356: a user MCP server, a skill outside Claude's dir and a Devia
 * sub-agent — each carrying a token the agent must quote back.
 */
function setUpHarness(ctx) {
  const skillDir = path.join(ctx.projectDir, '.agents', 'skills', 'e2e-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), `---\nname: e2e-skill\ndescription: Harness skill\n---\nThe code is ${HARNESS_TOKENS.skill}.\n`);
  const subDir = path.join(ctx.projectDir, '.devia', 'sub-agents');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'e2e-reviewer.md'),
    `---\nname: e2e-reviewer\ndescription: Harness reviewer\nagents: [claude]\n---\nYour code is ${HARNESS_TOKENS.subagent}.\n`);
  ctx.userServers.set([{
    id: 'e2e-echo', name: 'e2e-echo', command: process.execPath,
    args: [path.join(__dirname, 'echo-mcp.cjs')], enabled: true,
  }]);
}

/** What the renderer saves after a run: the user turn and the assistant text. */
function persistTranscript(ctx, sessions, scenario, result) {
  const sessionId = ctx.registry.find(ctx.project)?.activeSessionId;
  if (!sessionId) return;
  const text = result.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  sessions.append(sessionId, [
    { id: `${result.runId}-u`, role: 'user', text: scenario.prompt },
    { id: `${result.runId}-a`, role: 'assistant', text, runId: result.runId },
  ]);
}

// ── fixtures ───────────────────────────────────────────────────────────────

function redact(text) {
  return text
    .split(os.homedir()).join('~')
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_-]{16,}/g, '<REDACTED>')
    .replace(/("(?:api[_-]?key|token|authorization|secret)"\s*:\s*")[^"]+"/gi, '$1<REDACTED>"');
}

function recordFixture(agent, scenario, runId) {
  const dir = path.join(RAW_LOG_ROOT, agent);
  const short = runId.slice(0, 8);
  const file = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(`-${short}.jsonl`)).sort().pop() : undefined;
  if (!file) {
    console.warn(`  ! no raw log for ${agent}/${scenario} (run ${short})`);
    return;
  }
  const stdout = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.stream === 'stdout')
    .map((r) => r.chunk)
    .join('');
  const out = path.join(APP_ROOT, 'src/main/features/agents', agent, '__fixtures__', `${scenario}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, redact(stdout));
  console.log(`  ✎ fixture ${path.relative(APP_ROOT, out)}`);
}

// ── compare ────────────────────────────────────────────────────────────────

function diff(a, b, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const x = a?.[k];
    const y = b?.[k];
    if (x && y && typeof x === 'object' && typeof y === 'object' && !Array.isArray(x)) out.push(...diff(x, y, `${prefix}${k}.`));
    else if (JSON.stringify(x) !== JSON.stringify(y)) out.push(`${prefix}${k}: expected ${JSON.stringify(x)} got ${JSON.stringify(y)}`);
  }
  return out;
}

async function runAgent(agent, flags) {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), `devia-agent-e2e-${agent}-`));
  workspaceRoot = fs.realpathSync(workspace);
  const projectDir = path.join(workspaceRoot, 'proj');
  fs.mkdirSync(projectDir);
  childProcess.execSync('git init -q', { cwd: projectDir });
  const deviaDir = path.join(workspaceRoot, '.devia-app');
  const fakeAcp = AGENTS[agent].fake ? buildFakeAcpAgent(writeFakeAcpLauncher(workspaceRoot)) : undefined;
  const { useCase, registry, sessions, userServers, setKit } = buildHeadlessRun({
    agentId: agent, workspaceRoot, deviaDir, ...(AGENTS[agent].model && { model: AGENTS[agent].model }), ...(fakeAcp && { fakeAcp }),
  });
  const ctx = { useCase, registry, userServers, setKit, project: 'proj', projectDir, workspaceRoot, deviaDir, answer: AGENTS[agent].answer };
  let failures = 0;
  const scenarios = (flags.scenario ? SCENARIOS.filter((s) => s.id === flags.scenario) : SCENARIOS)
    .filter((s) => !s.claudeOnly || agent === 'claude')
    .filter((s) => !fakeAcp || FAKE_SCRIPTS[s.id] !== undefined);
  for (const scenario of scenarios) {
    process.stdout.write(`▶ ${agent}/${scenario.id} … `);
    if (scenario.harness) setUpHarness(ctx);
    if (scenario.kit) ctx.setKit(true);
    if (fakeAcp) fakeAcp.def.env = { FAKE_ACP_SCRIPT: JSON.stringify(FAKE_SCRIPTS[scenario.id]) };
    const result = await runScenario(ctx, scenario);
    if (scenario.harness) ctx.userServers.set([]);
    if (scenario.kit) ctx.setKit(false);
    persistTranscript(ctx, sessions, scenario, result);
    const snap = buildSnapshot(ctx, agent, scenario, result);
    const file = path.join(SNAP_DIR, `${agent}-${scenario.id}.json`);
    if (flags.record && result.runId) recordFixture(agent, scenario.id, result.runId);
    if (flags.update || !fs.existsSync(file)) {
      fs.writeFileSync(file, JSON.stringify(snap, null, 2) + '\n');
      console.log(`written (${result.end.code === 0 ? 'exit 0' : `exit ${result.end.code} ${result.end.error ?? ''}`})`);
      continue;
    }
    const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
    const wiring = diff(expected.wiring, snap.wiring);
    const behaviour = diff(expected.behaviour, snap.behaviour);
    if (wiring.length === 0 && behaviour.length === 0) console.log('ok');
    else console.log(wiring.length ? 'FAIL' : 'warn');
    wiring.forEach((d) => console.log(`    ✗ wiring.${d}`));
    behaviour.forEach((d) => console.log(`    ~ behaviour.${d}`));
    if (wiring.length) failures++;
  }
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
  return failures;
}

async function main() {
  const [target = 'all', ...rest] = process.argv.slice(2);
  const scenarioAt = rest.indexOf('--scenario');
  const flags = {
    update: rest.includes('--update'),
    record: rest.includes('--record'),
    scenario: scenarioAt >= 0 ? rest[scenarioAt + 1] : undefined,
  };
  // The launcher's raw-stream logger only runs in dev Electron or with this flag.
  if (flags.record) process.env.DEVIA_LOG_RAW_CLI = '1';
  const agents = target === 'all' ? ['claude', 'pi', 'opencode'] : [target];
  for (const a of agents) if (!AGENTS[a]) throw new Error(`unknown agent ${a}; one of ${Object.keys(AGENTS).join(', ')}`);
  fs.mkdirSync(SNAP_DIR, { recursive: true });
  let failures = 0;
  for (const agent of agents) failures += await runAgent(agent, flags);
  console.log(failures ? `\n${failures} wiring mismatch(es)` : '\nwiring matches the snapshots');
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
