#!/usr/bin/env node
'use strict';
/**
 * Generates the legacy-agent golden table from the PRE-S-30 code (S-30 T-354).
 *
 *   node tools/legacy-equivalence/generate-golden.cjs <pre-s30 dist/main> <out.json>
 *
 * It replays exactly what the old RunInstructionUseCase + launcher did for an
 * agent without a dedicated mapper: extraArgs = buildExtraArgs + resume, the
 * launcher's argv / stdin, and the native MCP config the three injectors
 * wrote. The committed output is the oracle the equivalence test checks the
 * NEW pipeline (LegacyMapper) against.
 */
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { cases, INPUT } = require('./cases.cjs');

const [distArg, outArg] = process.argv.slice(2);
const DIST = path.resolve(distArg);
const req = (rel) => require(path.join(DIST, rel));

let captured = null;
childProcess.spawn = (command, args, options) => {
  const proc = new EventEmitter();
  const writes = [];
  proc.stdin = { write: (c) => { writes.push(String(c)); return true; }, end: () => undefined, on: () => proc.stdin, once: () => proc.stdin };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.pid = 1;
  proc.kill = () => true;
  captured = { args: [...args], stdio0: options.stdio[0], stdin: writes };
  return proc;
};

const { ChildProcessCliLauncher } = req('src-main/features/cli-adapters/infrastructure/cli-launcher.js');
const { AGENT_DEFS } = req('src-main/features/cli-adapters/infrastructure/registry.js');
const { buildDefaultCapabilities } = req('shared/domain/run-capabilities.js');
const { MemoryMcpInjector } = req('src-main/features/memory/mcp-server/memory-mcp-injector.js');
const { KanbanMcpInjector } = req('src-main/features/sdd/mcp-server/kanban-mcp-injector.js');
const { UiMcpInjector } = req('src-main/features/ui-tools/mcp-server/ui-mcp-injector.js');

const handlers = { onOutput() {}, onDone() {}, onError(m) { captured = { error: String(m) }; } };

function spawnFor(def, c) {
  const capabilities = buildDefaultCapabilities(INPUT.runId, c.mode, { defaultDisallowedTools: def.defaultDisallowedTools ?? [] });
  const resumeSessionId = c.resume ? INPUT.resumeSessionId : undefined;
  const extraArgs = [
    ...(def.buildExtraArgs?.({ systemPrompt: INPUT.systemPrompt, capabilities, ...(resumeSessionId && { resumeSessionId }) }) ?? []),
    ...(resumeSessionId && def.buildResumeArgs ? def.buildResumeArgs(resumeSessionId) : []),
  ];
  captured = null;
  new ChildProcessCliLauncher().launch({
    def,
    cwd: INPUT.cwd,
    prompt: INPUT.prompt,
    envOverrides: {},
    options: { model: INPUT.model, reasoning: INPUT.reasoning },
    extraArgs,
    ...(['stdin-prepend', 'argv-prepend', 'argv-file'].includes(def.systemPromptStrategy) && { systemPrompt: INPUT.systemPrompt }),
    ...(c.mode !== 'apply-yolo' && { extraAllowedDirs: [INPUT.workspaceRoot] }),
    mode: c.mode,
    runId: INPUT.runId,
    ...(resumeSessionId && { resumeSessionId }),
  }, handlers);
  return captured;
}

/** The native MCP config the old injectors produced (memory + kanban + ui). */
function nativeConfigFor(agentId) {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-golden-'));
  // Agents with a GLOBAL MCP config (grok) resolve it under os.homedir():
  // point HOME at the sandbox so the developer's real files are never touched.
  const realHome = process.env.HOME;
  process.env.HOME = project;
  try {
    new UiMcpInjector().inject(agentId, project, INPUT.uiDir, INPUT.uiTools);
    new MemoryMcpInjector(() => INPUT.deviaDir).inject(agentId, project, INPUT.cwd);
    new KanbanMcpInjector(() => INPUT.deviaDir).inject(agentId, INPUT.cwd, project);
    const files = {};
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else files[path.relative(project, full)] = fs.readFileSync(full, 'utf8');
      }
    };
    walk(project);
    return files;
  } finally {
    process.env.HOME = realHome;
    fs.rmSync(project, { recursive: true, force: true });
  }
}

const golden = { generatedFrom: process.argv[2], cases: [] };
const nativeByAgent = {};
for (const c of cases(AGENT_DEFS)) {
  const def = AGENT_DEFS.find((d) => d.id === c.agentId);
  golden.cases.push({ ...c, spawn: spawnFor(def, c) });
  if (!(c.agentId in nativeByAgent)) nativeByAgent[c.agentId] = nativeConfigFor(c.agentId);
}
golden.nativeConfig = nativeByAgent;
fs.writeFileSync(outArg, JSON.stringify(golden, null, 2) + '\n');
console.log(`${golden.cases.length} cases, ${Object.keys(nativeByAgent).length} agents → ${outArg}`);
// The launcher arms an idle watchdog per spawn; nothing else is pending.
process.exit(0);
