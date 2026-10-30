'use strict';
/**
 * The input matrix for the legacy-agent equivalence check (S-30 T-354): every
 * agent still on LegacyMapper × mode × fresh/resumed run, with fixed inputs so
 * old and new pipelines can be compared byte for byte.
 */
const DEDICATED = new Set(['claude', 'pi', 'opencode']);
const MODES = ['plan', 'apply', 'apply-yolo'];
const INPUT = {
  cwd: '/ws/proj',
  workspaceRoot: '/ws',
  prompt: 'PROMPT',
  systemPrompt: 'SYS',
  model: 'm1',
  reasoning: 'high',
  runId: 'run-1',
  resumeSessionId: 'sess-1',
  uiDir: '/tmp/devia-ui/run-1',
  deviaDir: '/home/u/.devia-app',
  uiTools: ['ask_user', 'todo'],
};

function cases(agentDefs) {
  const out = [];
  for (const def of agentDefs) {
    if (DEDICATED.has(def.id) || (def.providerType ?? 'cli') !== 'cli') continue;
    for (const mode of MODES) {
      for (const resume of [false, true]) out.push({ agentId: def.id, mode, resume });
    }
  }
  return out;
}

module.exports = { cases, INPUT, DEDICATED };
