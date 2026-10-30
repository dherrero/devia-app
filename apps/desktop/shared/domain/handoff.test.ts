import { describe, it, expect } from 'vitest';
import { buildHandoffBrief, HANDOFF_MAX_TOTAL_CHARS, HANDOFF_TOUCHED_FILES_CAP } from './handoff';
import type { ChatMessage } from './chat';

const user = (text: string): ChatMessage => ({ id: 'u', role: 'user', text });
const assistant = (over: Partial<ChatMessage> = {}): ChatMessage => ({
  id: 'a', role: 'assistant', text: 'hecho', agentId: 'claude', ...over,
});
const editCall = (file: string) => ({ id: 't1', name: 'Edit', input: { file_path: file } });

describe('buildHandoffBrief (S-2 F2.1)', () => {
  it('empty transcript produces an empty-but-valid brief', () => {
    const brief = buildHandoffBrief([]);
    expect(brief.fromAgentId).toBeUndefined();
    expect(brief.goal).toBeUndefined();
    expect(brief.touchedFiles).toEqual([]);
    expect(brief.tail).toEqual([]);
    expect(brief.rendered).toContain('Continuación de sesión iniciada con otro agente');
  });

  it('only-user transcript yields goal and tail but no agent or files', () => {
    const brief = buildHandoffBrief([user('refactoriza el módulo de pagos')]);
    expect(brief.fromAgentId).toBeUndefined();
    expect(brief.goal).toBe('refactoriza el módulo de pagos');
    expect(brief.touchedFiles).toEqual([]);
    expect(brief.tail).toEqual([{ role: 'user', text: 'refactoriza el módulo de pagos' }]);
  });

  it('goal skips short acknowledgements like "ok" and "sí"', () => {
    const brief = buildHandoffBrief([
      user('implementa el login con JWT'),
      assistant(),
      user('ok'),
      user('sí'),
    ]);
    expect(brief.goal).toBe('implementa el login con JWT');
  });

  it('collects unique touched files from Edit/Write/MultiEdit toolCalls only', () => {
    const brief = buildHandoffBrief([
      assistant({
        toolCalls: [
          editCall('/ws/p/src/a.ts'),
          { id: 't2', name: 'Write', input: { file_path: '/ws/p/src/b.ts' } },
          { id: 't3', name: 'Bash', input: { command: 'rm -rf /' } },
          { id: 't4', name: 'MultiEdit', input: { path: '/ws/p/src/a.ts' } },
        ],
      }),
      assistant({ toolCalls: [editCall('/ws/p/src/a.ts')] }),
    ]);
    expect(brief.touchedFiles).toEqual(['/ws/p/src/a.ts', '/ws/p/src/b.ts']);
  });

  it('relativizes touched files when workspaceRoot is provided', () => {
    const brief = buildHandoffBrief(
      [assistant({ toolCalls: [editCall('/ws/p/src/a.ts')] })],
      { workspaceRoot: '/ws/p' },
    );
    expect(brief.touchedFiles).toEqual(['src/a.ts']);
  });

  it('caps touched files at the cap constant', () => {
    const calls = Array.from({ length: 40 }, (_, i) => editCall(`/ws/f${i}.ts`));
    const brief = buildHandoffBrief([assistant({ toolCalls: calls })]);
    expect(brief.touchedFiles).toHaveLength(HANDOFF_TOUCHED_FILES_CAP);
  });

  it('tail keeps the last N user/assistant turns, oldest first, clipped per message', () => {
    const brief = buildHandoffBrief(
      [
        user('m1'),
        assistant({ text: 'r1' }),
        user('m2 con un texto largo'.repeat(10)),
        assistant({ text: 'r2' }),
        user('m3 final'),
      ],
      { tailTurns: 3, maxCharsPerMessage: 20 },
    );
    expect(brief.tail).toHaveLength(3);
    expect(brief.tail[0]!.text.length).toBeLessThanOrEqual(20);
    expect(brief.tail[2]).toEqual({ role: 'user', text: 'm3 final' });
  });

  it('tail excludes system/outbox messages and empty bubbles', () => {
    const brief = buildHandoffBrief([
      { id: 's', role: 'system', text: 'error tal' },
      assistant({ text: '' }),
      user('pregunta real'),
    ]);
    expect(brief.tail).toEqual([{ role: 'user', text: 'pregunta real' }]);
  });

  it('respects maxTotalChars by dropping oldest tail entries first', () => {
    const long = 'x'.repeat(900);
    const brief = buildHandoffBrief(
      [user(long), assistant({ text: long }), user(long), assistant({ text: long })],
      { maxTotalChars: 2200 },
    );
    expect(brief.rendered.length).toBeLessThanOrEqual(2200);
    expect(brief.tail.length).toBeLessThan(4);
    expect(brief.tail[brief.tail.length - 1]!.role).toBe('assistant');
  });

  it('default rendered output is stable for fixed input', () => {
    const brief = buildHandoffBrief([
      user('añade tests al servicio de usuarios'),
      assistant({ text: 'Voy a ello.', toolCalls: [editCall('/ws/p/user.service.spec.ts')] }),
    ]);
    expect(brief.rendered).toBe([
      '## Continuación de sesión iniciada con claude',
      '',
      '**Objetivo en curso:** añade tests al servicio de usuarios',
      '',
      '**Ficheros tocados:**',
      '- /ws/p/user.service.spec.ts',
      '',
      '**Últimos intercambios:**',
      '- Usuario: añade tests al servicio de usuarios',
      '- Asistente: Voy a ello.',
    ].join('\n'));
    expect(brief.rendered.length).toBeLessThanOrEqual(HANDOFF_MAX_TOTAL_CHARS);
  });

  it('summaryBody (F2.3) renders between files and tail; absent → byte-identical brief', () => {
    const messages = [
      user('añade tests al servicio de usuarios'),
      assistant({ text: 'Voy a ello.', toolCalls: [editCall('/ws/p/user.service.spec.ts')] }),
    ];
    const deterministic = buildHandoffBrief(messages);
    const enriched = buildHandoffBrief(messages, { summaryBody: 'Resolved: setup. Active: tests.' });

    expect(buildHandoffBrief(messages).rendered).toBe(deterministic.rendered);
    expect(enriched.rendered).toContain('**Resumen de la sesión:**\nResolved: setup. Active: tests.');
    const summaryIdx = enriched.rendered.indexOf('**Resumen de la sesión:**');
    expect(summaryIdx).toBeGreaterThan(enriched.rendered.indexOf('**Ficheros tocados:**'));
    expect(summaryIdx).toBeLessThan(enriched.rendered.indexOf('**Últimos intercambios:**'));
    // The verbatim tail always survives alongside the compressed body.
    expect(enriched.tail).toEqual(deterministic.tail);
  });

  it('fromAgentId follows the last assistant agentId (session_started not required)', () => {
    const brief = buildHandoffBrief([assistant({ agentId: 'codex' }), assistant({ agentId: 'gemini' })]);
    expect(brief.fromAgentId).toBe('gemini');
  });
});
