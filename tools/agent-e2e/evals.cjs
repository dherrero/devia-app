#!/usr/bin/env node
'use strict';
/**
 * Behaviour evals of the Devia Method (S-39 T-426). Real agents, real Devia pipeline, a SIMULATED USER
 * answering cards and follow-up messages from a script. Assertions are on what the agent DID — tool calls, the
 * kanban it left behind, the files and commits in the project — never on what it wrote in prose.
 *
 *   node tools/agent-e2e/evals.cjs <agent> [--cases brainstorm,plan,execute,trivial,bugfix] [--cheap] [--repeat 3]
 *
 *   brainstorm → plan → execute run as ONE session in one workspace (each builds on the last).
 *   trivial and bugfix get their own workspace.
 *   --cheap     only `brainstorm` and `trivial` (the two that need the least tokens).
 *   --repeat N  run the selected cases N times and report k/N per assertion: a model is not deterministic,
 *               so a skill change is judged by the majority, not by one run.
 *
 * Costs real money and needs the CLIs installed and logged in. Never runs in CI. Requires `npm run build:main`.
 */
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildHeadlessRun } = require('./headless.cjs');

const AGENTS = {
  claude: { model: 'haiku' },
  pi: {},
  opencode: { model: 'opencode/deepseek-v4.1-flash-free' },
  codex: {},
  gemini: {},
};
const TURN_TIMEOUT_MS = { default: 8 * 60 * 1000, execute: 20 * 60 * 1000 };
const IGNORED = new Set(['.git', '.gitignore', '.devia', '.claude', '.mcp.json', '.pi', '.codex', '.gemini', 'opencode.json']);

const GENERIC_ANSWER =
  'Whatever you recommend is fine for anything I have not said. If the design is ready, I approve it: record it.';
const PLAN_ACCEPTED = 'The user ACCEPTED the plan. End your turn now; do not start implementing in this turn.';

// ── a turn with a simulated user ────────────────────────────────────────────

function runTurn(ctx, { prompt, mode, timeoutMs }) {
  return new Promise((resolve) => {
    const events = [];
    const ui = [];
    let runId = '';
    let finished = false;
    const done = (end) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (process.env.E2E_DEBUG) {
        const calls = events.filter((e) => e.type === 'tool_use').map((e) => `${e.name}${e.name && /skill|Skill/.test(e.name) ? ' ' + JSON.stringify(e.input ?? e.arguments ?? '').slice(0, 60) : ''}`);
        const text = events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('').slice(0, 200).replace(/\n/g, ' ');
        console.log(`\n    [turn] tools: ${calls.join(', ') || '(none)'}\n    [turn] text: ${text}`);
      }
      setTimeout(() => resolve({ events, ui, end, runId }), 300);
    };
    const timer = setTimeout(() => {
      ctx.registry.cancelRun?.(runId, 'user');
      done({ code: null, error: 'eval timeout' });
    }, timeoutMs);
    const answer = (callId, content) => setTimeout(() => ctx.registry.writeToolResult(ctx.project, callId, content), 150);
    const reply = (tool) => (tool === 'plan_approve' ? PLAN_ACCEPTED : tool === 'confirm' ? 'yes' : tool === 'request_review' ? 'The user approved the changes. No comments.' : GENERIC_ANSWER);

    ctx.useCase.execute(ctx.project, prompt, [], {
      onProcessStart: (p) => { runId = p.runId; },
      onClaudeOutput: (line) => { try { events.push(JSON.parse(line)); } catch { /* raw */ } },
      onProcessEnd: (p) => done({ code: p.code, error: p.error }),
      onOutboxFile: () => {},
      onQuestionAsk: (toolUseId) => { ui.push('ask_user'); answer(toolUseId, GENERIC_ANSWER); },
      onUiToolRequest: (callId, tool, _input, _runId, expectsAnswer) => {
        ui.push(tool);
        if (expectsAnswer) answer(callId, reply(tool));
      },
    }, mode);
  });
}

function persist(ctx, turn, prompt) {
  const sessionId = ctx.registry.find(ctx.project)?.activeSessionId;
  if (!sessionId) return;
  const text = turn.events.filter((e) => e.type === 'text_delta').map((e) => e.delta).join('');
  ctx.sessions.append(sessionId, [
    { id: `${turn.runId}-u`, role: 'user', text: prompt },
    { id: `${turn.runId}-a`, role: 'assistant', text, runId: turn.runId },
  ]);
}

// ── what the agent left behind ──────────────────────────────────────────────

function board(ctx) {
  const dir = path.join(ctx.deviaDir, 'projects');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).map((k) => path.join(dir, k, 'kanban.json')).filter((f) => fs.existsSync(f)) : [];
  const empty = { specs: [], tasks: [] };
  if (files.length === 0) return empty;
  try { return JSON.parse(fs.readFileSync(files[0], 'utf8')); } catch { return empty; }
}

const uses = (turns) => turns.flatMap((t) => t.events.filter((e) => e.type === 'tool_use'));
const named = (calls, re) => calls.filter((c) => re.test(c.name ?? ''));
const loadedSkill = (calls, skill) => calls.some((c) => JSON.stringify(c.input ?? c.arguments ?? c.args ?? c).includes(skill));
const projectFiles = (ctx) => fs.readdirSync(ctx.projectDir).filter((n) => !IGNORED.has(n));
const git = (ctx, ...args) => childProcess.execFileSync('git', args, { cwd: ctx.projectDir, encoding: 'utf8' }).trim();

// ── cases ───────────────────────────────────────────────────────────────────

const A = (name, pass, detail = '', soft = false) => ({ name, pass: !!pass, detail, soft });

const CASES = {
  brainstorm: {
    async run(ctx, state) {
      const turns = [];
      let prompt = 'I want a small CLI that lists the TODO comments in my code.';
      let specAfterFirst = null;
      let boardBeforeAnswer = null;
      for (let i = 0; i < 4; i++) {
        const t = await runTurn(ctx, { prompt, mode: 'plan', timeoutMs: TURN_TIMEOUT_MS.default });
        persist(ctx, t, prompt);
        turns.push(t);
        if (i === 0) {
          specAfterFirst = board(ctx).specs.length;
          // Writes to the board that happened BEFORE the user answered anything. An agent that asks through a
          // card is answered at once by the simulated user, so only writes ahead of its first card count.
          const calls = t.events.filter((e) => e.type === 'tool_use');
          const firstAsk = calls.findIndex((c) => /ask_user/.test(c.name ?? ''));
          const writes = calls.map((c, idx) => ({ c, idx })).filter(({ c }) => /kanban_create_(spec|task)/.test(c.name ?? ''));
          boardBeforeAnswer = writes.filter(({ idx }) => firstAsk < 0 || idx < firstAsk).length;
        }
        if (board(ctx).specs.length > 0) break;
        prompt = GENERIC_ANSWER;
      }
      state.turns.push(...turns);
      const calls = uses(turns);
      const b = board(ctx);
      return [
        A('loads brainstorming before anything else', loadedSkill(uses(turns.slice(0, 1)), 'brainstorming')),
        A('puts nothing on the board before the user has answered', boardBeforeAnswer === 0, `board writes before the first answer: ${boardBeforeAnswer}; specs after turn 1: ${specAfterFirst}`),
        A('records exactly ONE spec once the design is approved', b.specs.length === 1, `specs: ${b.specs.length}`),
        A('writes no file (plan mode)', projectFiles(ctx).length === 0, projectFiles(ctx).join(', ')),
        A('recalls memory before asking', named(calls, /mem_(search|context)/).length > 0, '', true),
      ];
    },
  },

  plan: {
    async run(ctx, state) {
      const prompt = 'Now plan the work. Keep it to two or three small tasks.';
      const t = await runTurn(ctx, { prompt, mode: 'plan', timeoutMs: TURN_TIMEOUT_MS.default });
      persist(ctx, t, prompt);
      state.turns.push(t);
      const calls = uses([t]);
      const b = board(ctx);
      const header = b.tasks.filter((x) => /^plan header/i.test(x.title));
      const work = b.tasks.filter((x) => !/^plan header/i.test(x.title));
      return [
        A('puts the plan on the board as tasks', work.length >= 2, `tasks: ${work.length}`),
        A('creates the plan header task', header.length === 1, `headers: ${header.length}`),
        A('orders tasks with dependsOn', work.some((x) => (x.dependsOn ?? []).length > 0), '', true),
        A('keeps one spec (no duplicate)', b.specs.length === 1, `specs: ${b.specs.length}`),
        A('asks for approval with the plan card', t.ui.includes('plan_approve') || named(calls, /plan_approve/).length > 0),
        A('writes no file (plan mode)', projectFiles(ctx).length === 0, projectFiles(ctx).join(', ')),
      ];
    },
  },

  execute: {
    async run(ctx, state) {
      const prompt = 'The user approved the plan. Execute it.';
      // "Accept and don't ask": under `apply` Claude runs with acceptEdits, which headless runs cannot extend to Bash.
      const t = await runTurn(ctx, { prompt, mode: 'apply-yolo', timeoutMs: TURN_TIMEOUT_MS.execute });
      persist(ctx, t, prompt);
      state.turns.push(t);
      const calls = uses([t]);
      const b = board(ctx);
      const closed = b.tasks.filter((x) => x.column === 'done' && !/^plan header/i.test(x.title));
      const commits = Number(git(ctx, 'rev-list', '--count', 'HEAD'));
      const writes = calls.filter((c) => /(^|_)(Write|Edit|MultiEdit|write|edit|apply_patch)$/i.test(c.name ?? '') || /write_file|replace/i.test(c.name ?? ''));
      const pathOf = (c) => String((c.input ?? c.arguments ?? {}).file_path ?? (c.input ?? c.arguments ?? {}).path ?? '');
      const firstTest = writes.findIndex((c) => /test|spec/i.test(pathOf(c)));
      const firstSrc = writes.findIndex((c) => pathOf(c) && !/test|spec/i.test(pathOf(c)));
      return [
        A('closes at least one task with its commit', closed.some((x) => x.closingCommit), `done: ${closed.length}, with commit: ${closed.filter((x) => x.closingCommit).length}`),
        A('leaves a record in the task thread', closed.some((x) => (x.thread ?? []).some((m) => m.author !== 'system')), '', true),
        A('commits the work', commits > 1, `commits: ${commits}`),
        A('writes a test file', projectFiles(ctx).some((n) => /test|spec/i.test(n)) || writes.some((c) => /test|spec/i.test(pathOf(c)))),
        A('writes the test before the code (TDD)', firstTest >= 0 && (firstSrc < 0 || firstTest < firstSrc), `first test write #${firstTest}, first source write #${firstSrc}`, true),
        A('publishes progress with devia_todo', named(calls, /devia_todo/).length > 0, '', true),
      ];
    },
  },

  trivial: {
    fresh: true,
    fixture(dir) { fs.writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\nconsole.log(x);\n'); },
    async run(ctx, state) {
      const prompt = 'In a.js rename the variable x to count.';
      const t = await runTurn(ctx, { prompt, mode: 'apply', timeoutMs: TURN_TIMEOUT_MS.default });
      state.turns.push(t);
      const calls = uses([t]);
      const src = fs.readFileSync(path.join(ctx.projectDir, 'a.js'), 'utf8');
      return [
        A('does the rename', /count/.test(src) && !/\bx\b/.test(src), src.trim().split('\n').join(' | ')),
        A('does NOT start a brainstorm for a trivial, fully specified request', !loadedSkill(calls, 'brainstorming')),
        A('creates no spec', board(ctx).specs.length === 0),
      ];
    },
  },

  bugfix: {
    fresh: true,
    fixture(dir) {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'bug', version: '1.0.0', scripts: { test: 'node --test' } }, null, 2));
      fs.writeFileSync(path.join(dir, 'sum.js'), 'exports.sum = (a, b) => a - b;\n');
      fs.writeFileSync(path.join(dir, 'sum.test.js'), "const test = require('node:test');\nconst assert = require('node:assert');\nconst { sum } = require('./sum');\ntest('adds', () => assert.strictEqual(sum(2, 3), 5));\n");
    },
    async run(ctx, state) {
      const prompt = 'npm test is failing. Fix it.';
      const t = await runTurn(ctx, { prompt, mode: 'apply', timeoutMs: TURN_TIMEOUT_MS.default });
      state.turns.push(t);
      const calls = uses([t]);
      let passes = true;
      try { childProcess.execSync('npm test', { cwd: ctx.projectDir, stdio: 'pipe' }); } catch { passes = false; }
      const testSrc = fs.readFileSync(path.join(ctx.projectDir, 'sum.test.js'), 'utf8');
      return [
        A('npm test passes', passes),
        A('fixes the code, not the test', /sum\(2, 3\), 5/.test(testSrc)),
        A('loads systematic-debugging', loadedSkill(calls, 'systematic-debugging'), '', true),
        A('saves the root cause to memory (bugfix)', named(calls, /mem_save/).length > 0, '', true),
      ];
    },
  },
};

// ── driver ──────────────────────────────────────────────────────────────────

function workspace(agent, fixture) {
  const ws = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `devia-eval-${agent}-`)));
  const projectDir = path.join(ws, 'proj');
  fs.mkdirSync(projectDir);
  childProcess.execSync('git init -q && git config user.email e@e.e && git config user.name eval', { cwd: projectDir });
  if (fixture) fixture(projectDir);
  fs.writeFileSync(path.join(projectDir, '.gitignore'), '.devia/\n');
  childProcess.execSync('git add -A && git commit -qm init', { cwd: projectDir });
  const deviaDir = path.join(ws, '.devia-app');
  const built = buildHeadlessRun({ agentId: agent, workspaceRoot: ws, deviaDir, ...AGENTS[agent] });
  built.setKit(true);
  return { ws, ctx: { ...built, project: 'proj', projectDir, workspaceRoot: ws, deviaDir } };
}

async function runOnce(agent, selected) {
  const results = [];
  const chain = selected.filter((c) => !CASES[c].fresh);
  const fresh = selected.filter((c) => CASES[c].fresh);
  if (chain.length > 0) {
    const { ws, ctx } = workspace(agent);
    const state = { turns: [] };
    for (const name of chain) {
      process.stdout.write(`  ▶ ${name} … `);
      const out = await CASES[name].run(ctx, state);
      console.log(out.every((a) => a.pass || a.soft) ? 'done' : 'FAILED');
      results.push({ name, assertions: out });
    }
    fs.rmSync(ws, { recursive: true, force: true });
  }
  for (const name of fresh) {
    const { ws, ctx } = workspace(agent, CASES[name].fixture);
    process.stdout.write(`  ▶ ${name} … `);
    const out = await CASES[name].run(ctx, { turns: [] });
    console.log(out.every((a) => a.pass || a.soft) ? 'done' : 'FAILED');
    results.push({ name, assertions: out });
    fs.rmSync(ws, { recursive: true, force: true });
  }
  return results;
}

async function main() {
  const [agent, ...rest] = process.argv.slice(2);
  if (!agent || !AGENTS[agent]) throw new Error(`usage: evals.cjs <${Object.keys(AGENTS).join('|')}> [--cases a,b] [--cheap] [--repeat N]`);
  const casesAt = rest.indexOf('--cases');
  const repeatAt = rest.indexOf('--repeat');
  const repeat = repeatAt >= 0 ? Number(rest[repeatAt + 1]) : 1;
  const order = ['brainstorm', 'plan', 'execute', 'trivial', 'bugfix'];
  let selected = casesAt >= 0 ? rest[casesAt + 1].split(',') : rest.includes('--cheap') ? ['brainstorm', 'trivial'] : order;
  for (const c of selected) if (!CASES[c]) throw new Error(`unknown case ${c}`);
  selected = order.filter((c) => selected.includes(c));
  if (selected.includes('plan') && !selected.includes('brainstorm')) throw new Error('`plan` builds on `brainstorm`');
  if (selected.includes('execute') && !selected.includes('plan')) throw new Error('`execute` builds on `plan`');

  const tally = new Map();
  for (let i = 1; i <= repeat; i++) {
    console.log(`\n${agent} — run ${i}/${repeat}`);
    for (const r of await runOnce(agent, selected)) {
      for (const a of r.assertions) {
        const key = `${r.name} · ${a.name}${a.soft ? ' (soft)' : ''}`;
        const cur = tally.get(key) ?? { pass: 0, total: 0, soft: a.soft, details: [] };
        cur.total++;
        if (a.pass) cur.pass++; else if (a.detail) cur.details.push(a.detail);
        tally.set(key, cur);
      }
    }
  }
  console.log(`\n=== ${agent} ===`);
  let hardFailures = 0;
  for (const [key, v] of tally) {
    const ok = v.pass * 2 > v.total;
    if (!ok && !v.soft) hardFailures++;
    console.log(`${ok ? '✓' : v.soft ? '~' : '✗'} ${key}  ${v.pass}/${v.total}${v.details.length ? `   [${v.details.slice(0, 2).join(' ; ')}]` : ''}`);
  }
  console.log(hardFailures ? `\n${hardFailures} assertion(s) failed by majority` : '\nall hard assertions hold by majority');
  process.exit(hardFailures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(2); });
