import { describe, it, expect } from 'vitest';
import { buildConversationReplay, REPLAY_MAX_TOTAL_CHARS } from './conversation-replay';
import type { ChatMessage } from './chat';

function user(id: string, text: string): ChatMessage {
  return { id, role: 'user', text };
}
function assistant(id: string, text: string, toolCalls?: ChatMessage['toolCalls']): ChatMessage {
  return { id, role: 'assistant', text, ...(toolCalls ? { toolCalls } : {}) };
}

describe('buildConversationReplay', () => {
  it('returns null with no messages (first turn)', () => {
    expect(buildConversationReplay([], { maxChars: REPLAY_MAX_TOTAL_CHARS })).toBeNull();
  });

  it('returns null when no substantive user/assistant turns exist', () => {
    const msgs: ChatMessage[] = [
      { id: 's', role: 'system', text: 'session reset' },
      { id: 'h', role: 'assistant', text: 'brief', kind: 'handoff' },
      { id: 'e', role: 'user', text: '   ' },
    ];
    expect(buildConversationReplay(msgs, { maxChars: REPLAY_MAX_TOTAL_CHARS })).toBeNull();
  });

  it('renders prior user + assistant turns with a delimiting header', () => {
    const block = buildConversationReplay(
      [user('1', 'arregla el login'), assistant('2', 'hecho, revisa auth.ts')],
      { maxChars: REPLAY_MAX_TOTAL_CHARS },
    );
    expect(block).not.toBeNull();
    expect(block).toContain('Conversación previa');
    expect(block).toContain('Usuario: arregla el login');
    expect(block).toContain('Asistente: hecho, revisa auth.ts');
  });

  it('summarizes assistant tool calls and touched files (workspace-relative)', () => {
    const block = buildConversationReplay(
      [
        user('1', 'edita el fichero'),
        assistant('2', 'listo', [
          { id: 't1', name: 'Edit', input: { file_path: '/ws/proj/src/a.ts' } },
          { id: 't2', name: 'Bash', input: { command: 'ls' } },
        ]),
      ],
      { maxChars: REPLAY_MAX_TOTAL_CHARS, workspaceRoot: '/ws/proj' },
    );
    expect(block).toContain('[herramientas: Edit, Bash]');
    expect(block).toContain('[ficheros: src/a.ts]');
    expect(block).not.toContain('/ws/proj/src/a.ts');
  });

  it('keeps an assistant turn that only ran tools (no text)', () => {
    const block = buildConversationReplay(
      [user('1', 'corre los tests'), assistant('2', '', [{ id: 't', name: 'Bash', input: { command: 'npm test' } }])],
      { maxChars: REPLAY_MAX_TOTAL_CHARS },
    );
    expect(block).toContain('Asistente: [herramientas: Bash]');
  });

  it('drops oldest turns first and never exceeds maxChars', () => {
    const msgs: ChatMessage[] = [];
    for (let i = 0; i < 40; i++) {
      msgs.push(user(`u${i}`, `pregunta número ${i} `.repeat(20)));
      msgs.push(assistant(`a${i}`, `respuesta número ${i} `.repeat(20)));
    }
    const cap = 1500;
    const block = buildConversationReplay(msgs, { maxChars: cap });
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThanOrEqual(cap);
    // Freshest exchange survives; oldest is gone.
    expect(block).toContain('respuesta número 39');
    expect(block).not.toContain('pregunta número 0 ');
  });

  it('clips an overly long single message to maxCharsPerMessage', () => {
    const huge = 'x'.repeat(5000);
    const block = buildConversationReplay([user('1', huge)], {
      maxChars: REPLAY_MAX_TOTAL_CHARS,
      maxCharsPerMessage: 100,
    });
    expect(block).not.toBeNull();
    expect(block).toContain('…');
    expect(block!.length).toBeLessThan(400);
  });
});
