import { describe, it, expect } from 'vitest';
import { orderedBodies, splitBodies, type PromptBodies } from './prompt-bodies';

const all: PromptBodies = {
  packs: ['PACK1', 'PACK2'],
  skillRegistry: 'SKILL',
  kit: 'KIT',
  memoryProtocol: 'MEMPROTO',
  memoryContext: 'MEMCTX',
  handoff: 'HANDOFF',
  worktree: 'WT',
  remote: 'REMOTE',
  uiFallback: 'UIFB',
  plan: 'PLAN',
};

describe('orderedBodies', () => {
  it('keeps the historical order', () => {
    expect(orderedBodies(all)).toEqual([
      'PACK1', 'PACK2', 'SKILL', 'KIT', 'MEMPROTO', 'MEMCTX', 'HANDOFF', 'WT', 'REMOTE', 'UIFB', 'PLAN',
    ]);
  });

  it('drops nulls and keeps the rest in order', () => {
    expect(orderedBodies({ ...all, skillRegistry: null, kit: null, plan: null })).toEqual([
      'PACK1', 'PACK2', 'MEMPROTO', 'MEMCTX', 'HANDOFF', 'WT', 'REMOTE', 'UIFB',
    ]);
  });
});

describe('splitBodies', () => {
  it('keeps memoryContext in stable on the first turn', () => {
    expect(splitBodies(all, { firstTurn: true })).toEqual({
      stable: ['PACK1', 'PACK2', 'SKILL', 'KIT', 'MEMPROTO', 'MEMCTX', 'HANDOFF'],
      turn: ['WT', 'REMOTE', 'UIFB', 'PLAN'],
    });
  });

  it('moves memoryContext to turn on a resumed turn', () => {
    expect(splitBodies(all, { firstTurn: false })).toEqual({
      stable: ['PACK1', 'PACK2', 'SKILL', 'KIT', 'MEMPROTO', 'HANDOFF'],
      turn: ['MEMCTX', 'WT', 'REMOTE', 'UIFB', 'PLAN'],
    });
  });

  it('loses and duplicates nothing', () => {
    for (const firstTurn of [true, false]) {
      const { stable, turn } = splitBodies(all, { firstTurn });
      expect(new Set([...stable, ...turn])).toEqual(new Set(orderedBodies(all)));
      expect(stable.length + turn.length).toBe(orderedBodies(all).length);
    }
  });
});
