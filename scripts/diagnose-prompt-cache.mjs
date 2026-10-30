#!/usr/bin/env node
/**
 * S-16 T-180 — Prompt-cache diagnostic.
 *
 * Reads the raw Claude stream logs that `raw-stream-logger.ts` writes to
 * `~/.devia-app/logs/agent-cli/claude/<isoTs>-<runIdShort>.jsonl` (gated on
 * IS_DEV or DEVIA_LOG_RAW_CLI=1) and reports, per turn, how much of the prompt
 * prefix was served from the Anthropic prompt cache (cache_read) versus
 * re-written (cache_creation). Each log file = one `claude -p` run = one turn.
 *
 * Usage:
 *   node scripts/diagnose-prompt-cache.mjs            # grouped by session
 *   node scripts/diagnose-prompt-cache.mjs --summary  # aggregate only
 *   DEVIA_LOG_DIR=/custom/path node scripts/diagnose-prompt-cache.mjs
 *
 * No deps, read-only. Safe to run anytime.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir =
  process.env.DEVIA_LOG_DIR ??
  path.join(os.homedir(), '.devia-app', 'logs', 'agent-cli', 'claude');

if (!fs.existsSync(dir)) {
  console.error(`No log dir at ${dir}. Run a session with DEVIA_LOG_RAW_CLI=1 first.`);
  process.exit(1);
}

const summaryOnly = process.argv.includes('--summary');
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();

/** Reassemble the child stdout from the {ts,stream,chunk} envelope and return
 *  the first message_start usage block (the cache state at turn start). */
function firstUsage(file) {
  let full = '';
  for (const ln of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
    if (!ln) continue;
    try {
      const o = JSON.parse(ln);
      if (typeof o.chunk === 'string') full += o.chunk;
    } catch {
      /* skip */
    }
  }
  let sid = null;
  for (const s of full.split('\n')) {
    if (!s) continue;
    let o;
    try {
      o = JSON.parse(s);
    } catch {
      continue;
    }
    if (o.type === 'system' && o.subtype === 'init' && o.session_id) sid = o.session_id;
    const ev = o.type === 'stream_event' && o.event ? o.event : o;
    if (ev.type === 'message_start' && ev.message?.usage) {
      return { sid, usage: ev.message.usage };
    }
  }
  return null;
}

const rows = [];
for (const f of files) {
  const hit = firstUsage(f);
  if (!hit) continue;
  const u = hit.usage;
  rows.push({
    time: f.slice(11, 19),
    sid: (hit.sid ?? '????????').slice(0, 8),
    input: u.input_tokens ?? 0,
    write: u.cache_creation_input_tokens ?? 0,
    read: u.cache_read_input_tokens ?? 0,
    e5m: u.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    e1h: u.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  });
}

let W = 0, R = 0, I = 0, cold = 0, e5 = 0, e1 = 0;
for (const r of rows) {
  W += r.write; R += r.read; I += r.input; e5 += r.e5m; e1 += r.e1h;
  if (r.read === 0) cold++;
}

if (!summaryOnly) {
  const bySid = {};
  for (const r of rows) (bySid[r.sid] ??= []).push(r);
  for (const sid of Object.keys(bySid)) {
    const rs = bySid[sid];
    if (rs.length < 2) continue;
    console.log(`\n── session ${sid} (${rs.length} turns) ──`);
    console.log('time      input    WRITE     READ   %hit');
    for (const r of rs) {
      const tot = r.input + r.write + r.read;
      const pct = tot ? Math.round((100 * r.read) / tot) : 0;
      console.log(
        [r.time, String(r.input).padStart(6), String(r.write).padStart(8),
         String(r.read).padStart(8), pct + '%'].join('  '),
      );
    }
  }
}

console.log('\n═══ aggregate ═══');
console.log('turns analysed:        ', rows.length);
console.log('cache WRITE total:     ', W.toLocaleString());
console.log('cache READ total:      ', R.toLocaleString());
console.log('uncached input total:  ', I.toLocaleString());
console.log('WRITE/READ ratio:      ', (W / Math.max(R, 1)).toFixed(2), '(>1 = rewrites more than it reuses)');
console.log('0%-hit turns:          ', cold, `= ${Math.round((100 * cold) / Math.max(rows.length, 1))}%`);
console.log('TTL bucket:            ', e1 > e5 ? '1 HOUR' : '5 min', `(5m=${e5.toLocaleString()}, 1h=${e1.toLocaleString()})`);
