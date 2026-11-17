import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * S-46: the kit's skills outrank the agent's defaults, so none of them may let
 * the agent ask in plain text when `devia_ask_user` is offered. The base prompt
 * says "ALWAYS use the card"; these are the sentences that used to say the
 * opposite.
 */
const KIT = path.resolve(__dirname, '..', '..', '..', '..', 'resources', 'kits', 'devia-method', 'skills');

const skillFiles = (): string[] =>
  fs.readdirSync(KIT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => path.join(KIT, e.name, 'SKILL.md'))
    .filter((f) => fs.existsSync(f));

const read = (name: string): string => fs.readFileSync(path.join(KIT, name, 'SKILL.md'), 'utf8');

const BANNED = [
  /plain conversation for open questions/i,
  /only when they['’]re stuck/i,
  /They pick in the conversation/i,
  /Open questions come first, in plain conversation/i,
  /Each message ends with one question: a single sentence/i,
];

describe('kit skills ask with the card', () => {
  it('no skill lets the agent ask in plain text when the card is offered', () => {
    for (const file of skillFiles()) {
      const body = fs.readFileSync(file, 'utf8');
      for (const re of BANNED) expect(body, `${file} matches ${re}`).not.toMatch(re);
    }
  });

  it('brainstorming and using-devia say the card is ALWAYS used when it is offered', () => {
    expect(read('brainstorming')).toMatch(/ALWAYS[^.\n]*`devia_ask_user`/);
    expect(read('using-devia')).toMatch(/ALWAYS[^.\n]*`devia_ask_user`/);
  });

  it('plain text stays only as the fallback when cards are not offered', () => {
    for (const name of ['brainstorming', 'finishing-work', 'writing-plans']) {
      expect(read(name)).toMatch(/aren['’]t offered|isn['’]t offered|not offered/);
    }
  });
});
