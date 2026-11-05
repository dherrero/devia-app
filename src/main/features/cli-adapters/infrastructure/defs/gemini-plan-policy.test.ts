import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { GEMINI_PLAN_POLICY, geminiAgentDef } from './gemini';

let deviaDir: string;
beforeEach(() => { deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-gemini-policy-')); });
afterEach(() => fs.rmSync(deviaDir, { recursive: true, force: true }));

const filesFor = (mode: 'plan' | 'apply' | 'apply-yolo') =>
  geminiAgentDef.buildRunFiles?.({ mode, deviaDir, runId: 'run-1' }) ?? null;

describe('Gemini plan-mode policy', () => {
  it('is only written for plan mode', () => {
    expect(filesFor('apply')).toBeNull();
    expect(filesFor('apply-yolo')).toBeNull();
    expect(fs.existsSync(path.join(deviaDir, 'tmp'))).toBe(false);
  });

  it('writes a per-run policy under the data dir, hands it to Gemini, and removes it afterwards', () => {
    const files = filesFor('plan');
    expect(files?.args[0]).toBe('--policy');
    const file = files?.args[1] ?? '';
    expect(file.startsWith(path.join(deviaDir, 'tmp'))).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(GEMINI_PLAN_POLICY);
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    files?.cleanup();
    expect(fs.existsSync(file)).toBe(false);
  });

  it("allows Devia's three servers in plan mode and nothing else", () => {
    for (const server of ['devia-kanban', 'devia-memory', 'devia-ui']) {
      expect(GEMINI_PLAN_POLICY).toContain(`mcpName = "${server}"`);
    }
    const allows = GEMINI_PLAN_POLICY.split('[[rule]]').filter((r) => r.includes('decision = "allow"'));
    expect(allows).toHaveLength(3);
    for (const rule of allows) expect(rule).toMatch(/modes = \["plan"\]/);
  });

  it('stops the agent from leaving plan mode by itself', () => {
    const deny = GEMINI_PLAN_POLICY.split('[[rule]]').find((r) => r.includes('toolName = "exit_plan_mode"'));
    expect(deny).toContain('decision = "deny"');
    expect(deny).toContain('modes = ["plan"]');
  });

  it('keeps plan mode itself: the approval flag is untouched', () => {
    expect(geminiAgentDef.buildExtraArgs?.({ systemPrompt: '', capabilities: { mode: 'plan' } as never })).toEqual(['--approval-mode', 'plan']);
  });
});
