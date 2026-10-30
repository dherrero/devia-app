import { describe, it, expect } from 'vitest';
import {
  buildHandoffRequestPrompt,
  canRequestHandoffSummary,
  detectPendingHandoff,
  lastAssistantAgentId,
} from './agent-handoff.util';
import type { ChatMessage } from '../../../../../../shared/domain/chat';

const user = (text: string): ChatMessage => ({ id: 'u', role: 'user', text });
const assistant = (agentId?: string): ChatMessage =>
  ({ id: 'a', role: 'assistant', text: 'ok', ...(agentId !== undefined && { agentId }) }) as ChatMessage;

describe('lastAssistantAgentId', () => {
  it('returns the agentId of the LAST assistant message that carries one', () => {
    expect(lastAssistantAgentId([assistant('codex'), user('x'), assistant('claude'), assistant()])).toBe('claude');
  });

  it('returns null for empty / user-only / unowned transcripts', () => {
    expect(lastAssistantAgentId(undefined)).toBeNull();
    expect(lastAssistantAgentId([])).toBeNull();
    expect(lastAssistantAgentId([user('hola')])).toBeNull();
    expect(lastAssistantAgentId([assistant()])).toBeNull();
  });
});

describe('detectPendingHandoff (S-2 F3.3)', () => {
  it('detects a mismatch on the focused session and names its owner', () => {
    const pending = detectPendingHandoff({
      newAgentId: 'claude',
      focusedKey: '/p',
      mountedKeys: [],
      chats: new Map([['/p', [assistant('codex')]]]),
    });
    expect(pending).toEqual({ fromAgentId: 'codex', affectedKeys: ['/p'] });
  });

  it('returns null when the session has no history or the same agent owns it', () => {
    expect(detectPendingHandoff({
      newAgentId: 'claude', focusedKey: '/p', mountedKeys: [], chats: new Map([['/p', []]]),
    })).toBeNull();
    expect(detectPendingHandoff({
      newAgentId: 'claude', focusedKey: '/p', mountedKeys: [], chats: new Map([['/p', [assistant('claude')]]]),
    })).toBeNull();
  });

  it('counts affected mounted panes too (split)', () => {
    const pending = detectPendingHandoff({
      newAgentId: 'claude',
      focusedKey: '/p',
      mountedKeys: ['pane-1', 'pane-2'],
      chats: new Map([
        ['/p', [assistant('codex')]],
        ['pane-1', [assistant('gemini')]],
        ['pane-2', [assistant('claude')]],
      ]),
    });
    expect(pending?.affectedKeys).toEqual(['/p', 'pane-1']);
    expect(pending?.fromAgentId).toBe('codex');
  });

  it('only offers the summary request when the previous agent is operative (F3.4)', () => {
    const agents = [
      { id: 'codex', selectable: true, authStatus: 'ok' as const },
      { id: 'gemini', selectable: true, authStatus: 'missing' as const },
      { id: 'api-x', selectable: false, authStatus: 'ok' as const },
    ];
    expect(canRequestHandoffSummary(agents, 'codex')).toBe(true);
    expect(canRequestHandoffSummary(agents, 'gemini')).toBe(false);
    expect(canRequestHandoffSummary(agents, 'api-x')).toBe(false);
    expect(canRequestHandoffSummary(agents, 'desconocido')).toBe(false);
    expect(canRequestHandoffSummary(null, 'codex')).toBe(false);
  });

  it('the handoff request prompt orders a mem_session_summary with the required sections (F3.4)', () => {
    const prompt = buildHandoffRequestPrompt();
    expect(prompt).toContain('mem_session_summary');
    expect(prompt).toContain('Objetivo');
    expect(prompt).toContain('Decisiones');
    expect(prompt).toContain('Siguiente paso');
    expect(prompt).toContain('Ficheros');
  });

  it('uses the first affected pane as source when the focused session is clean', () => {
    const pending = detectPendingHandoff({
      newAgentId: 'claude',
      focusedKey: '/p',
      mountedKeys: ['pane-1'],
      chats: new Map([
        ['/p', [assistant('claude')]],
        ['pane-1', [assistant('gemini')]],
      ]),
    });
    expect(pending).toEqual({ fromAgentId: 'gemini', affectedKeys: ['pane-1'] });
  });
});
