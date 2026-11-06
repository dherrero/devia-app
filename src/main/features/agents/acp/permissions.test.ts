import { describe, expect, it } from 'vitest';
import type { RunMode } from '../../../../shared/domain/run-capabilities';
import { allowOption, decidePermission, rejectOption, type AcpPermissionOption } from './permissions';
import { profileFor, type AcpAgentProfile } from './profile';

const found = profileFor('kimi');
if (!found) throw new Error('kimi profile missing');
const PROFILE: AcpAgentProfile = found;

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
];
const SERVERS = ['devia-ui', 'devia-kanban', 'user-srv', 'devia-custom'];
const DEVIA_SERVERS = ['devia-ui', 'devia-kanban'];

function decide(
  kind: string | undefined,
  mode: RunMode,
  isRemote: boolean,
  opts: { options?: AcpPermissionOption[]; title?: string } = {},
) {
  return decidePermission({
    toolCall: { toolCallId: 't', title: opts.title ?? 'Do thing', ...(kind !== undefined && { kind }) },
    options: opts.options ?? OPTIONS,
    mode,
    isRemote,
    serverIds: SERVERS,
    deviaServerIds: DEVIA_SERVERS,
    profile: PROFILE,
  });
}

describe('decidePermission', () => {
  it.each(['edit', 'delete', 'move', 'execute'])('plan rejects %s on desktop and remote', (kind) => {
    expect(decide(kind, 'plan', false)).toEqual({ kind: 'select', optionId: 'r1' });
    expect(decide(kind, 'plan', true)).toEqual({ kind: 'select', optionId: 'r1' });
  });

  it('plan rejects with cancel when there is no reject option', () => {
    const options = OPTIONS.filter((o) => o.kind.startsWith('allow'));
    expect(decide('edit', 'plan', false, { options })).toEqual({ kind: 'cancel' });
  });

  it.each(['read', 'search', 'think', 'fetch'])('plan allows %s on desktop and asks on remote', (kind) => {
    expect(decide(kind, 'plan', false)).toEqual({ kind: 'select', optionId: 'a2' });
    expect(decide(kind, 'plan', true)).toEqual({ kind: 'ask' });
  });

  it.each(['other', 'execute'])('plan allows a Devia MCP tool even if its kind is %s', (kind) => {
    expect(decide(kind, 'plan', false, { title: 'mcp__devia-kanban__kanban_list' })).toEqual({
      kind: 'select',
      optionId: 'a2',
    });
  });

  it('plan does not trust a user MCP tool of kind execute', () => {
    expect(decide('execute', 'plan', false, { title: 'mcp__user-srv__run' })).toEqual({
      kind: 'select',
      optionId: 'r1',
    });
  });

  it('plan does not trust a user server whose id merely starts with devia-', () => {
    expect(decide('execute', 'plan', false, { title: 'mcp__devia-custom__run' })).toEqual({ kind: 'select', optionId: 'r1' });
  });

  it('plan does not trust an agent-chosen name that is not one of the Devia servers of the run', () => {
    expect(decide('edit', 'plan', false, { title: 'devia-memory/notes' })).toEqual({ kind: 'select', optionId: 'r1' });
    expect(decide('edit', 'plan', false, { title: 'devia-evil_write' })).toEqual({ kind: 'select', optionId: 'r1' });
  });

  it('plan asks for an unknown kind', () => {
    expect(decide('other', 'plan', false)).toEqual({ kind: 'ask' });
    expect(decide(undefined, 'plan', false)).toEqual({ kind: 'ask' });
  });

  it.each(['read', 'edit', 'execute', 'other'])('apply asks for %s', (kind) => {
    expect(decide(kind, 'apply', false)).toEqual({ kind: 'ask' });
    expect(decide(kind, 'apply', true)).toEqual({ kind: 'ask' });
  });

  it('apply-yolo selects the broadest allow option on desktop', () => {
    expect(decide('edit', 'apply-yolo', false)).toEqual({ kind: 'select', optionId: 'a2' });
  });

  it('apply-yolo asks on a remote run', () => {
    expect(decide('edit', 'apply-yolo', true)).toEqual({ kind: 'ask' });
  });

  it('remote never selects an allow option', () => {
    for (const mode of ['plan', 'apply', 'apply-yolo'] as const) {
      for (const kind of ['read', 'search', 'think', 'fetch', 'edit', 'execute', 'other']) {
        const d = decide(kind, mode, true);
        if (d.kind === 'select') {
          expect(OPTIONS.find((o) => o.optionId === d.optionId)?.kind).toMatch(/^reject/);
        }
      }
    }
  });

  it('no options at all means ask', () => {
    expect(decide('read', 'plan', false, { options: [] })).toEqual({ kind: 'ask' });
    expect(decide('edit', 'apply-yolo', false, { options: [] })).toEqual({ kind: 'ask' });
  });
});

describe('option pickers', () => {
  it('allowOption prefers allow_always over allow_once', () => {
    expect(allowOption(OPTIONS)?.optionId).toBe('a2');
    expect(allowOption([OPTIONS[0] as AcpPermissionOption])?.optionId).toBe('a1');
    expect(allowOption([OPTIONS[2] as AcpPermissionOption])).toBeNull();
  });

  it('rejectOption prefers reject_once over reject_always', () => {
    const always: AcpPermissionOption = { optionId: 'r2', name: 'Never', kind: 'reject_always' };
    expect(rejectOption([always, ...OPTIONS])?.optionId).toBe('r1');
    expect(rejectOption([always])?.optionId).toBe('r2');
    expect(rejectOption([OPTIONS[0] as AcpPermissionOption])).toBeNull();
  });
});
