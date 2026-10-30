#!/usr/bin/env node
/**
 * Runtime dependency audit for CI.
 *
 * Same gate as `npm audit --omit=dev --audit-level=high`, plus an allowlist
 * for advisories that have NO fixed version and are not reachable from our
 * code. `npm audit` has no way to ignore one advisory, so without this a single
 * unfixable upstream bug blocks every PR in the repo.
 *
 * Rules:
 *  - any high/critical advisory not in `.github/audit-allowlist.json` fails;
 *  - an allowlist entry past its `reviewBy` date fails too, so an exception is
 *    re-justified instead of living forever;
 *  - an entry that no longer matches anything is reported, so it gets removed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BLOCKING = new Set(['high', 'critical']);

function runAudit() {
  try {
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    // npm audit exits non-zero whenever it finds anything; the JSON is still on stdout.
    if (err.stdout) return err.stdout;
    throw err;
  }
}

const allowlist = JSON.parse(readFileSync(join(ROOT, '.github/audit-allowlist.json'), 'utf8'));
const allowed = new Map(allowlist.advisories.map((a) => [a.id, a]));
const report = JSON.parse(runAudit());

const found = new Map();
for (const [pkg, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of vuln.via) {
    if (typeof via === 'string' || !BLOCKING.has(via.severity)) continue;
    const id = via.url?.split('/').pop() ?? String(via.source);
    if (!found.has(id)) found.set(id, { id, pkg, title: via.title, severity: via.severity, url: via.url });
  }
}

const today = new Date().toISOString().slice(0, 10);
const failures = [];
for (const adv of found.values()) {
  const entry = allowed.get(adv.id);
  if (!entry) {
    failures.push(`${adv.severity.toUpperCase()} ${adv.pkg}: ${adv.title} (${adv.url})`);
  } else if (entry.reviewBy < today) {
    failures.push(`Allowlist entry ${adv.id} (${adv.pkg}) expired on ${entry.reviewBy}: re-check it and extend or remove it.`);
  } else {
    console.log(`allowed  ${adv.id} ${adv.pkg} — ${entry.reason}`);
  }
}

for (const id of allowed.keys()) {
  if (!found.has(id)) console.log(`unused   ${id} — no longer reported, remove it from the allowlist.`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} runtime advisory issue(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nRuntime audit OK (${found.size} high/critical advisories, all allowlisted).`);
