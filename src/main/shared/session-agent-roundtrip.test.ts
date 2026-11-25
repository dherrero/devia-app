/**
 * S-53 phase 2, against the REAL session store: the session agent survives the
 * JSON round trip, a pane's first save, and a later save that knows nothing of it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FsSessionStore } from '../features/sessions/infrastructure/fs-session-store';
import { SaveChatUseCase } from '../features/sessions/application/save-chat.use-case';
import { SessionAgentIndex } from './session-agent-index';
import { InMemoryProjectRegistry } from '../features/claude-runner/infrastructure/in-memory-project-registry';

const SID = '33333333-2222-4333-8333-555555555555';

describe('session agent round trip (real FsSessionStore)', () => {
  let dir: string;
  let workspace: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-sa-'));
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-saws-'));
    fs.mkdirSync(path.join(workspace, 'proj'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(workspace, { recursive: true, force: true });
  });

  const build = () => {
    const sessions = new FsSessionStore({ deviaDir: () => dir, get: () => ({ workspaceRoot: workspace }) } as never);
    const index = new SessionAgentIndex({ sessions });
    const saveChat = new SaveChatUseCase({ registry: new InMemoryProjectRegistry(), sessions, state: { load: () => undefined, save: () => undefined }, sessionAgents: index });
    return { sessions, index, saveChat };
  };

  it('a choice made before the pane has a session is written by its first save and read back by a fresh index', () => {
    const a = build();
    a.index.set('proj', SID, 'codex');
    a.saveChat.saveAs('proj', SID, [{ id: 'm1', role: 'user', text: 'hola' }]);

    const b = build(); // a restart: nothing in memory
    expect(b.sessions.load('proj', SID)?.preferredAgentId).toBe('codex');
    expect(new SessionAgentIndex({ sessions: b.sessions }).get('proj', SID)).toBe('codex');
  });

  it('later saves keep it, and setting null removes it from disk', () => {
    const a = build();
    a.saveChat.saveAs('proj', SID, [{ id: 'm1', role: 'user', text: 'uno' }]);
    a.index.set('proj', SID, 'pi');
    a.saveChat.saveAs('proj', SID, [{ id: 'm1', role: 'user', text: 'uno' }, { id: 'm2', role: 'user', text: 'dos' }]);
    expect(a.sessions.load('proj', SID)?.preferredAgentId).toBe('pi');

    a.index.set('proj', SID, null);
    expect(a.sessions.load('proj', SID)).not.toHaveProperty('preferredAgentId');
  });

  it('a pane closed without ever running leaves nothing on disk', () => {
    const a = build();
    a.index.set('proj', SID, 'codex');
    expect(a.sessions.load('proj', SID)).toBeNull();
  });
});
