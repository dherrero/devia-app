#!/usr/bin/env node
'use strict';
/**
 * Agent E2E harness (S-30 T-344). Drives REAL CLI agents through Devia's real
 * run pipeline and compares what happened against committed snapshots.
 *
 *   node tools/agent-e2e/run.cjs <claude|pi|opencode|all> [--update] [--record]
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

const { buildHeadlessRun } = require('./headless.cjs');
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
};

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
        entry.stdin.push(String(chunk));
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
  return [...ids].sort();
}

function systemPromptChannel(spawn) {
  const i = spawn.args.indexOf('--append-system-prompt');
  if (i >= 0) {
    const v = spawn.args[i + 1] || '';
    return spawn.files[v] !== undefined ? 'argv-file' : 'argv';
  }
  const stdin = spawn.stdin.join('');
  if (stdin.includes('[System]')) return 'stdin-prepend';
  return 'none';
}

function systemPromptText(spawn) {
  const i = spawn.args.indexOf('--append-system-prompt');
  if (i >= 0) {
    const v = spawn.args[i + 1] || '';
    return spawn.files[v] ?? v;
  }
  const stdin = spawn.stdin.join('');
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

function stdinShape(spawn) {
  const raw = spawn.stdin.join('');
  if (!raw) return { format: 'none' };
  const lines = raw.split('\n').filter((l) => l.trim());
  const json = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } });
  if (json.every((j) => j && typeof j === 'object')) {
    return { format: 'jsonl', types: [...new Set(json.map((j) => j.type))].sort() };
  }
  return { format: 'text', systemHeader: raw.startsWith('[System]') };
}

/** Facts about the system prompt that must survive any refactor. */
function systemPromptFacts(text) {
  return {
    announcesUiTools: /devia_ask_user/.test(text),
    announcesMemory: /mem_save|mem_search/.test(text),
    mentionsKanban: /kanban/i.test(text),
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

    const answer = (callId, content) =>
      setTimeout(() => ctx.registry.writeToolResult(ctx.project, callId, content), 150);

    ctx.useCase.execute(ctx.project, scenario.prompt, [], {
      onProcessStart: (p) => { runId = p.runId; },
      onClaudeOutput: (line) => { try { events.push(JSON.parse(line)); } catch { /* raw */ } },
      onProcessEnd: (p) => done({ code: p.code, error: p.error }),
      onOutboxFile: () => {},
      onQuestionAsk: (toolUseId) => { ui.push('ask_user'); answer(toolUseId, ANSWER); },
      onUiToolRequest: (callId, tool, _input, _runId, expectsAnswer) => {
        ui.push(tool);
        if (expectsAnswer) answer(callId, tool === 'confirm' ? 'yes' : ANSWER);
      },
    }, scenario.mode);
  });
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
        systemPrompt: { channel: systemPromptChannel(spawn), ...systemPromptFacts(systemPromptText(spawn)) },
        uiServer: uiServerFacts(spawn),
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
    ...(scenario.id === 'plan' && { wroteFile: fs.existsSync(path.join(ctx.projectDir, 'notas.txt')) }),
    ...(scenario.harness && {
      quoted: Object.fromEntries(Object.entries(HARNESS_TOKENS).map(([k, token]) => [k, finalText.includes(token)])),
    }),
  };
  return { agent, scenario: scenario.id, wiring, behaviour };
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
  const { useCase, registry, sessions, userServers } = buildHeadlessRun({ agentId: agent, workspaceRoot, deviaDir, ...AGENTS[agent] });
  const ctx = { useCase, registry, userServers, project: 'proj', projectDir, workspaceRoot, deviaDir };
  let failures = 0;
  const scenarios = flags.scenario ? SCENARIOS.filter((s) => s.id === flags.scenario) : SCENARIOS;
  for (const scenario of scenarios) {
    process.stdout.write(`▶ ${agent}/${scenario.id} … `);
    if (scenario.harness) setUpHarness(ctx);
    const result = await runScenario(ctx, scenario);
    if (scenario.harness) ctx.userServers.set([]);
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
