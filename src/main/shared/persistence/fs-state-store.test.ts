import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsStateStore } from './fs-state-store';
import { InMemoryProjectRegistry } from '../../features/claude-runner/infrastructure/in-memory-project-registry';

describe('FsStateStore — preferredAgentId (S-53)', () => {
  let dir: string;
  let workspace: string;

  const build = (registry: InMemoryProjectRegistry) =>
    new FsStateStore({
      config: {
        deviaDir: () => dir,
        get: () => ({ workspaceRoot: workspace }),
      } as never,
      registry,
      pinned: { list: () => [], set: () => undefined } as never,
      sessions: { isValidSessionId: () => false } as never,
    });

  const stateFile = () => path.join(dir, 'state.json');

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-state-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-ws-'));
    fs.mkdirSync(path.join(workspace, 'proj-a'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  it('writes the project agent when set and survives a reload', () => {
    const first = new InMemoryProjectRegistry();
    first.getOrCreate('proj-a').preferredAgentId = 'codex';
    build(first).save();
    expect(JSON.parse(fs.readFileSync(stateFile(), 'utf8')).projects['proj-a'].preferredAgentId).toBe('codex');

    const second = new InMemoryProjectRegistry();
    build(second).load();
    expect(second.getOrCreate('proj-a').preferredAgentId).toBe('codex');
  });

  it('omits the key from state.json when the project has no agent', () => {
    const registry = new InMemoryProjectRegistry();
    registry.getOrCreate('proj-a');
    build(registry).save();
    expect('preferredAgentId' in JSON.parse(fs.readFileSync(stateFile(), 'utf8')).projects['proj-a']).toBe(false);
  });

  it('loads a legacy state.json without the field as null', () => {
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({ pinnedProjects: [], projects: { 'proj-a': { newSession: false, activeSessionId: null } } }),
    );
    const registry = new InMemoryProjectRegistry();
    build(registry).load();
    expect(registry.getOrCreate('proj-a').preferredAgentId).toBeNull();
  });

  it.each([[42], [{ id: 'codex' }], ['']])('loads a non-string or empty value (%j) as null', (bad) => {
    fs.writeFileSync(
      stateFile(),
      JSON.stringify({
        pinnedProjects: [],
        projects: { 'proj-a': { newSession: false, activeSessionId: null, preferredAgentId: bad } },
      }),
    );
    const registry = new InMemoryProjectRegistry();
    build(registry).load();
    expect(registry.getOrCreate('proj-a').preferredAgentId).toBeNull();
  });
});
