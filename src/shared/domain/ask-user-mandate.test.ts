import { describe, expect, it } from 'vitest';

import { ASK_USER_MANDATE_TAG, ASK_USER_REMINDER, hasAskUserMandate } from './ask-user-mandate';

describe('hasAskUserMandate', () => {
  it('is true when the system text carries the mandate block', () => {
    expect(hasAskUserMandate(`base <${ASK_USER_MANDATE_TAG} priority="mandatory">x</${ASK_USER_MANDATE_TAG}>`)).toBe(true);
  });

  it('is false for undefined, empty text and text without the tag', () => {
    expect(hasAskUserMandate(undefined)).toBe(false);
    expect(hasAskUserMandate('')).toBe(false);
    expect(hasAskUserMandate('Use devia_ask_user for choices.')).toBe(false);
  });

  it('the reminder is a single line', () => {
    expect(ASK_USER_REMINDER).not.toContain('\n');
    expect(ASK_USER_REMINDER).toContain('devia_ask_user');
  });
});
