import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SubAgentReader, DEVIA_DIR, SUB_AGENTS_SUBDIR } from '../infrastructure/sub-agent-reader';
import { SubAgentWriter } from '../infrastructure/sub-agent-writer';
import { InstallSubAgentUseCase } from './install-sub-agent.use-case';
import { RemoveSubAgentUseCase } from './remove-sub-agent.use-case';
import { AutoImportSubAgentsUseCase, SENTINEL_FILENAME } from './auto-import.use-case';

function setup() {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-subagents-'));
  const reader = new SubAgentReader();
  const writer = new SubAgentWriter();
  const install = new InstallSubAgentUseCase(reader, writer);
  const remove = new RemoveSubAgentUseCase(reader, writer);
  const autoImport = new AutoImportSubAgentsUseCase(reader);
  return {
    project,
    reader,
    install,
    remove,
    autoImport,
    cleanup: () => fs.rmSync(project, { recursive: true, force: true }),
  };
}

describe('InstallSubAgentUseCase', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('writes the source of truth + each selected CLI file', () => {
    const result = fx.install.execute(fx.project, {
      name: 'frontend-reviewer',
      description: 'UI reviewer',
      tools: ['Read', 'Grep'],
      agents: ['claude', 'cursor-agent'],
      body: '# Body',
    });

    expect(result.ok).toBe(true);
    const sot = path.join(fx.project, DEVIA_DIR, SUB_AGENTS_SUBDIR, 'frontend-reviewer.md');
    expect(fs.existsSync(sot)).toBe(true);
    const claudeFile = path.join(fx.project, '.claude', 'agents', 'frontend-reviewer.md');
    const cursorFile = path.join(fx.project, '.cursor', 'agents', 'frontend-reviewer.md');
    expect(fs.existsSync(claudeFile)).toBe(true);
    expect(fs.existsSync(cursorFile)).toBe(true);
    expect(fs.readFileSync(claudeFile, 'utf8')).toContain('devia_managed: true');
  });

  it('marks codex / deepseek as skipped without writing files', () => {
    const result = fx.install.execute(fx.project, {
      name: 'thing',
      description: 'desc',
      tools: [],
      agents: ['claude', 'codex'],
      body: '# Body',
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toContain('codex');
    expect(fs.existsSync(path.join(fx.project, '.codex'))).toBe(false);
  });

  it('removes the file from a CLI when the matrix is toggled off', () => {
    fx.install.execute(fx.project, {
      name: 'thing',
      description: 'desc',
      tools: [],
      agents: ['claude', 'cursor-agent'],
      body: '# Body',
    });
    const cursorFile = path.join(fx.project, '.cursor', 'agents', 'thing.md');
    expect(fs.existsSync(cursorFile)).toBe(true);

    // Toggle Cursor off (empty body — preserve existing body path).
    const result = fx.install.execute(fx.project, {
      name: 'thing',
      description: '',
      tools: [],
      agents: ['claude'],
      body: '',
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(cursorFile)).toBe(false);
    // Body preserved.
    const sot = fs.readFileSync(
      path.join(fx.project, DEVIA_DIR, SUB_AGENTS_SUBDIR, 'thing.md'), 'utf8',
    );
    expect(sot).toContain('# Body');
  });

  it('rejects invalid names', () => {
    const result = fx.install.execute(fx.project, {
      name: 'Has Spaces!',
      description: '',
      tools: [],
      agents: ['claude'],
      body: '# Body',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Nombre/);
  });

  it('transforms md → JSON for OpenCode', () => {
    fx.install.execute(fx.project, {
      name: 'planner',
      description: 'Plans things',
      tools: ['Read', 'Grep'],
      agents: ['opencode'],
      body: '# planner body',
    });
    const file = path.join(fx.project, 'opencode.json');
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(parsed.agent.planner.prompt).toContain('# planner body');
    expect(parsed.agent.planner.tools).toEqual(['Read', 'Grep']);
    expect(parsed.agent.planner.__devia_managed).toBe('planner');
  });

  it('writes a slash-command file for Qwen', () => {
    fx.install.execute(fx.project, {
      name: 'cmd',
      description: 'd',
      tools: [],
      agents: ['qwen'],
      body: '# cmd body',
    });
    const file = path.join(fx.project, '.qwen', 'commands', 'cmd.md');
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toContain('# cmd body');
  });

  it('flips Gemini experimental flag in settings.json', () => {
    fx.install.execute(fx.project, {
      name: 'gemini-agent',
      description: 'd',
      tools: [],
      agents: ['gemini'],
      body: '# body',
    });
    const settings = JSON.parse(
      fs.readFileSync(path.join(fx.project, '.gemini', 'settings.json'), 'utf8'),
    );
    expect(settings.experimental.enableAgents).toBe(true);
  });
});

describe('RemoveSubAgentUseCase', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('drops the source of truth + every CLI file', () => {
    fx.install.execute(fx.project, {
      name: 'x',
      description: 'd',
      tools: [],
      agents: ['claude', 'cursor-agent', 'opencode'],
      body: '# body',
    });
    fx.remove.execute(fx.project, 'x');
    expect(fs.existsSync(
      path.join(fx.project, DEVIA_DIR, SUB_AGENTS_SUBDIR, 'x.md'),
    )).toBe(false);
    expect(fs.existsSync(path.join(fx.project, '.claude', 'agents', 'x.md'))).toBe(false);
    expect(fs.existsSync(path.join(fx.project, '.cursor', 'agents', 'x.md'))).toBe(false);
    const oc = JSON.parse(fs.readFileSync(path.join(fx.project, 'opencode.json'), 'utf8'));
    expect(oc.agent).toBeUndefined();
  });

  it('preserves hand-added OpenCode entries (no marker)', () => {
    // Pre-seed opencode.json with a user entry.
    const file = path.join(fx.project, 'opencode.json');
    fs.writeFileSync(file, JSON.stringify({
      agent: { userBuilt: { description: 'u', prompt: 'p', tools: [] } },
    }), 'utf8');

    fx.install.execute(fx.project, {
      name: 'x',
      description: 'd',
      tools: [],
      agents: ['opencode'],
      body: '# body',
    });
    fx.remove.execute(fx.project, 'x');

    const oc = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(oc.agent.userBuilt.description).toBe('u');
    expect(oc.agent.x).toBeUndefined();
  });
});

describe('AutoImportSubAgentsUseCase', () => {
  let fx: ReturnType<typeof setup>;
  beforeEach(() => { fx = setup(); });
  afterEach(() => fx.cleanup());

  it('imports pre-existing .claude/agents/ into .devia/sub-agents/', () => {
    const claudeDir = path.join(fx.project, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'cloned.md'), [
      '---',
      'name: cloned',
      'description: From the cloned repo',
      'tools: Read, Grep',
      '---',
      '# body',
    ].join('\n'), 'utf8');

    const result = fx.autoImport.execute(fx.project);
    expect(result.imported).toEqual(['cloned']);
    const target = path.join(fx.project, DEVIA_DIR, SUB_AGENTS_SUBDIR, 'cloned.md');
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.readFileSync(target, 'utf8')).toContain('devia_managed: true');
  });

  it('is re-entrant — picks up new native files on subsequent runs', () => {
    const claudeDir = path.join(fx.project, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'a.md'), '---\nname: a\n---\n# body', 'utf8');

    const first = fx.autoImport.execute(fx.project);
    expect(first.imported).toEqual(['a']);
    expect(first.skipped).toBe(false);

    // Add a second file AFTER the first import. Auto-import must
    // still find + import it on the next run (re-entrant by design).
    fs.writeFileSync(path.join(claudeDir, 'b.md'), '---\nname: b\n---\n# body', 'utf8');
    const second = fx.autoImport.execute(fx.project);
    expect(second.imported).toEqual(['b']);
    expect(second.skipped).toBe(false);
  });

  it('skips files that already exist in .devia/sub-agents/', () => {
    const claudeDir = path.join(fx.project, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'a.md'), '---\nname: a\n---\n# body', 'utf8');

    fx.autoImport.execute(fx.project);
    // Edit the imported copy — the second pass MUST NOT clobber it.
    const target = path.join(fx.project, DEVIA_DIR, SUB_AGENTS_SUBDIR, 'a.md');
    const edited = '---\nname: a\ndevia_managed: true\n---\n# my own edits';
    fs.writeFileSync(target, edited, 'utf8');

    const second = fx.autoImport.execute(fx.project);
    expect(second.imported).toEqual([]);
    expect(fs.readFileSync(target, 'utf8')).toBe(edited);
  });

  it('returns skipped=true when no native sub-agents exist', () => {
    const result = fx.autoImport.execute(fx.project);
    expect(result.imported).toEqual([]);
    expect(result.skipped).toBe(true);
  });

  it('cleans up the legacy .imported sentinel from earlier versions', () => {
    const targetDir = path.join(fx.project, DEVIA_DIR, SUB_AGENTS_SUBDIR);
    fs.mkdirSync(targetDir, { recursive: true });
    const sentinel = path.join(targetDir, SENTINEL_FILENAME);
    fs.writeFileSync(sentinel, '# legacy sentinel from v1', 'utf8');

    // Add a native file so the scan has work to do.
    const claudeDir = path.join(fx.project, '.claude', 'agents');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'a.md'), '---\nname: a\n---\n# body', 'utf8');

    const result = fx.autoImport.execute(fx.project);
    expect(fs.existsSync(sentinel)).toBe(false);
    expect(result.imported).toEqual(['a']);
  });
});
