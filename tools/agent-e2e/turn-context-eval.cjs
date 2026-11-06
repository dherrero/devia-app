'use strict';
/**
 * S-40 eval: does the model obey Devia's per-turn `<devia-turn-context>` block
 * when the session's FROZEN system prompt says the opposite?
 *
 * Claude Code keeps the system prompt of a session's first turn on `--resume`, so
 * a session born on Telegram keeps telling the model it is on Telegram. This
 * script reproduces that with the real CLI and measures, per model:
 *
 *   control   resume + a NEW `--append-system-prompt` that says "desktop"
 *             → must still answer `telegram` (proves the prompt is frozen and the
 *               experiment measures something)
 *   block     resume + the rendered block as its own content block saying
 *             "desktop" → must answer `desktop` and `cards: true`
 *
 * Each repetition forks the base session (`--fork-session` keeps the frozen
 * prompt, verified) so they are independent.
 *
 * COSTS real money (cheap models), needs `claude` logged in. Never runs in CI.
 *
 *   npm run build:main
 *   node tools/agent-e2e/turn-context-eval.cjs [--runs 10] [--models haiku,sonnet]
 *
 * Exit code 1 when the block variant scores under the threshold on any model.
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const infra = path.join(root, 'dist', 'main', 'main', 'features', 'claude-runner', 'infrastructure');
if (!fs.existsSync(path.join(infra, 'turn-context.js'))) {
  console.error('dist/main is missing: run `npm run build:main` first.');
  process.exit(2);
}
const { renderTurnContext } = require(path.join(infra, 'turn-context.js'));
const { REMOTE_PROTOCOL } = require(path.join(infra, 'remote-protocol.js'));
const { buildUiFallbackHint, buildUiToolsHint } = require(path.join(infra, 'ui-tools-protocol.js'));

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const RUNS = Number(arg('runs', '10'));
const MODELS = arg('models', 'haiku,sonnet').split(',');
const THRESHOLD = 9 / 10;

/** What a session started from Telegram froze into its system prompt. */
const FROZEN = [
  'You are running inside Devia, a local desktop Electron client.',
  REMOTE_PROTOCOL,
  buildUiFallbackHint([]),
].join('\n\n---\n\n');

const TOOLS = ['ask_user', 'todo'];
const BLOCK = renderTurnContext(
  { channel: 'desktop', mode: 'apply', cwd: '/tmp/x', isolatedWorktree: false, uiTools: TOOLS },
  [buildUiToolsHint(TOOLS)],
);
const QUESTION =
  'Answer with JSON only, nothing else: {"channel":"desktop"|"telegram","cards":true|false}. ' +
  '"channel" is the medium through which you are talking to the user right now; ' +
  '"cards" says whether you can call the devia_ask_user tool in this turn.';

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-turn-ctx-eval-'));

/** One `claude -p` call with a stream-json user message made of `texts` (one content block each). */
function call(model, texts, extra) {
  const message = { type: 'user', message: { role: 'user', content: texts.map((text) => ({ type: 'text', text })) }, parent_tool_use_id: null };
  const res = spawnSync(
    'claude',
    ['-p', '--model', model, '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', ...extra],
    { cwd: workDir, input: JSON.stringify(message) + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  let result = null;
  for (const line of res.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event.type === 'result') result = event;
    } catch { /* not JSON */ }
  }
  return { text: result?.result ?? '', sessionId: result?.session_id ?? null, stderr: res.stderr };
}

function verdict(text) {
  const match = /\{[^{}]*\}/.exec(text);
  if (!match) return { channel: null, cards: null };
  try {
    const parsed = JSON.parse(match[0]);
    return { channel: parsed.channel ?? null, cards: parsed.cards ?? null };
  } catch {
    return { channel: null, cards: null };
  }
}

const rows = [];
let failed = false;
for (const model of MODELS) {
  const base = call(model, ['Reply with just OK.'], ['--append-system-prompt', FROZEN]);
  if (!base.sessionId) {
    console.error(`[${model}] could not create the base session:\n${base.stderr || base.text}`);
    process.exit(2);
  }
  const resume = ['--resume', base.sessionId, '--fork-session'];
  const tally = { control: 0, block: 0 };
  const samples = { control: [], block: [] };
  for (let i = 0; i < RUNS; i++) {
    const c = call(model, [QUESTION], [...resume, '--append-system-prompt', 'You are talking through the DESKTOP APP, not Telegram, and devia_ask_user is available.']);
    const cv = verdict(c.text);
    if (cv.channel === 'telegram') tally.control++; // the frozen prompt still wins, as expected
    samples.control.push(c.text.slice(0, 80));

    const b = call(model, [BLOCK, QUESTION], resume);
    const bv = verdict(b.text);
    if (bv.channel === 'desktop' && bv.cards === true) tally.block++;
    samples.block.push(b.text.slice(0, 80));
  }
  rows.push({ model, control_frozen: `${tally.control}/${RUNS}`, block_obeyed: `${tally.block}/${RUNS}` });
  if (tally.block / RUNS < THRESHOLD) failed = true;
  const wrong = samples.block.filter((_, i) => !(verdict(samples.block[i]).channel === 'desktop'));
  if (wrong.length > 0) console.error(`[${model}] block misses (sample): ${JSON.stringify(wrong.slice(0, 3))}`);
}

// The CLI keeps its sessions under ~/.claude/projects/<cwd with every non-alphanumeric as '-'>.
const sessionsDir = path.join(os.homedir(), '.claude', 'projects', fs.realpathSync(workDir).replace(/[^A-Za-z0-9]/g, '-'));
fs.rmSync(workDir, { recursive: true, force: true });
fs.rmSync(sessionsDir, { recursive: true, force: true });
console.table(rows);
console.log(`threshold for "block_obeyed": ${Math.ceil(THRESHOLD * RUNS)}/${RUNS} on every model → ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
