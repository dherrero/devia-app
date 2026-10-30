import { describe, expect, it } from 'vitest';

import { missingUiCapabilities, resolveAdvertisedUiTools, wiredUiTools } from './ui-tools-policy';

const base = { mode: 'apply', isRemote: false, delivered: true } as const;

describe('resolveAdvertisedUiTools', () => {
  it('offers the planning set in plan mode', () => {
    expect(resolveAdvertisedUiTools({ ...base, mode: 'plan' })).toEqual([
      'ask_user',
      'todo',
      'plan_approve',
      'skill',
    ]);
  });

  it('offers the execution set in apply and apply-yolo', () => {
    const apply = resolveAdvertisedUiTools(base);
    expect(apply).toEqual(['ask_user', 'todo', 'request_review', 'confirm', 'pick', 'notify', 'skill']);
    expect(resolveAdvertisedUiTools({ ...base, mode: 'apply-yolo' })).toEqual(apply);
  });

  it('never offers plan_approve outside plan, nor confirm inside it', () => {
    expect(resolveAdvertisedUiTools(base)).not.toContain('plan_approve');
    expect(resolveAdvertisedUiTools({ ...base, mode: 'plan' })).not.toContain('confirm');
  });

  it('withholds every interactive tool on a remote run', () => {
    expect(resolveAdvertisedUiTools({ ...base, isRemote: true })).toEqual([
      'todo',
      'notify',
      'skill',
    ]);
    expect(resolveAdvertisedUiTools({ ...base, mode: 'plan', isRemote: true })).toEqual([
      'todo',
      'skill',
    ]);
  });

  it('offers nothing when the server cannot be delivered', () => {
    expect(resolveAdvertisedUiTools({ ...base, delivered: false })).toEqual([]);
  });

  it('lets a preference narrow the policy but never widen it', () => {
    expect(resolveAdvertisedUiTools({ ...base, preferences: { confirm: false } })).not.toContain(
      'confirm',
    );
    expect(
      resolveAdvertisedUiTools({ ...base, mode: 'plan', preferences: { confirm: true } }),
    ).not.toContain('confirm');
  });

  it('drops capability-gated tools', () => {
    const out = resolveAdvertisedUiTools({ ...base, hasSkills: false, canNotify: false });
    expect(out).not.toContain('skill');
    expect(out).not.toContain('notify');
  });

  it('returns the canonical order regardless of anything else', () => {
    const out = resolveAdvertisedUiTools(base);
    expect([...out].sort()).not.toEqual(out); // canonical order is not alphabetical
    expect(out[0]).toBe('ask_user');
  });
});

describe('wiredUiTools', () => {
  it('narrows an advertised set to what this build can draw', () => {
    expect(wiredUiTools(['ask_user', 'confirm', 'todo'], ['todo'])).toEqual(['todo']);
  });

  it('offers plan_approve in plan mode now that its card exists', () => {
    const planned = resolveAdvertisedUiTools({ ...base, mode: 'plan' });
    expect(wiredUiTools(planned)).toContain('plan_approve');
  });

  it('never leaks plan_approve into apply, card or no card', () => {
    expect(wiredUiTools(resolveAdvertisedUiTools(base))).not.toContain('plan_approve');
  });

  it('drops a tool whose card has not landed yet', () => {
    // The guard that matters: a BLOCKING tool with no card would hang the run
    // until the kill timeout. Every tool has a card today, so the mechanism is
    // asserted against an explicit list rather than whichever one is pending.
    const advertised = resolveAdvertisedUiTools(base);
    expect(advertised).toContain('confirm');
    expect(wiredUiTools(advertised, ['ask_user', 'todo'])).toEqual(['ask_user', 'todo']);
  });

  it('every tool in the policy has a card — nothing can hang a run today', () => {
    for (const mode of ['plan', 'apply', 'apply-yolo'] as const) {
      const advertised = resolveAdvertisedUiTools({ ...base, mode });
      expect(wiredUiTools(advertised)).toEqual(advertised);
    }
  });
});

describe('remote (Telegram) degradation — S-25 F3.1', () => {
  it('offers exactly the three tools that need no click', () => {
    // A remote user cannot click a card. These three need no interaction, and
    // `notify` is MORE useful there than on the desktop: the chat is the only
    // channel they have.
    expect(resolveAdvertisedUiTools({ ...base, isRemote: true })).toEqual([
      'todo',
      'notify',
      'skill',
    ]);
  });

  it('withholds every tool that carries a decision', () => {
    const remote = resolveAdvertisedUiTools({ ...base, isRemote: true });
    for (const withheld of ['ask_user', 'plan_approve', 'request_review', 'confirm', 'pick']) {
      expect(remote).not.toContain(withheld);
    }
  });

  it('teaches the plain-text equivalent for every capability it withheld', () => {
    const remote = resolveAdvertisedUiTools({ ...base, isRemote: true });

    expect(missingUiCapabilities(remote)).toEqual([
      'ask_user',
      'plan_approve',
      'request_review',
      'confirm',
    ]);
  });

  it('costs far less prompt prefix than a desktop run', () => {
    // The reason this is a hard filter and not a UI tweak: a remote turn then
    // carries three tool schemas in its cached prefix instead of seven.
    const remote = resolveAdvertisedUiTools({ ...base, isRemote: true });
    const desktop = resolveAdvertisedUiTools(base);

    expect(remote.length).toBeLessThan(desktop.length / 2);
  });

  it('still narrows by mode — plan has no notify to offer', () => {
    expect(resolveAdvertisedUiTools({ ...base, mode: 'plan', isRemote: true })).toEqual([
      'todo',
      'skill',
    ]);
  });
});

describe('send_file — S-32', () => {
  it('is off unless the run can send files, so a desktop run is unchanged', () => {
    for (const mode of ['plan', 'apply', 'apply-yolo'] as const) {
      expect(resolveAdvertisedUiTools({ ...base, mode })).not.toContain('send_file');
      expect(resolveAdvertisedUiTools({ ...base, mode, canSendFiles: false })).not.toContain(
        'send_file',
      );
    }
  });

  // Decision (S-32 review, M4): kept in plan mode. Sending a file that already
  // exists is read-only, and it is the main remote use case; the schema cost is
  // capped separately in `ui-tools-budget.test.ts` (planWithSendFile).
  it('is offered in every mode when a chat relay can receive files', () => {
    expect(resolveAdvertisedUiTools({ ...base, mode: 'plan', canSendFiles: true })).toEqual([
      'ask_user',
      'todo',
      'plan_approve',
      'skill',
      'send_file',
    ]);
    expect(resolveAdvertisedUiTools({ ...base, canSendFiles: true })).toContain('send_file');
    expect(resolveAdvertisedUiTools({ ...base, mode: 'apply-yolo', canSendFiles: true })).toContain(
      'send_file',
    );
  });

  it('survives the remote filter: four tools with a relay, three without', () => {
    expect(resolveAdvertisedUiTools({ ...base, isRemote: true, canSendFiles: true })).toEqual([
      'todo',
      'notify',
      'skill',
      'send_file',
    ]);
    expect(resolveAdvertisedUiTools({ ...base, isRemote: true })).toEqual(['todo', 'notify', 'skill']);
  });

  it('is withdrawn by the user preference like any other tool', () => {
    expect(
      resolveAdvertisedUiTools({
        ...base,
        isRemote: true,
        canSendFiles: true,
        preferences: { send_file: false },
      }),
    ).not.toContain('send_file');
  });

  it('needs no card and no plain-text fallback', () => {
    const advertised = resolveAdvertisedUiTools({ ...base, canSendFiles: true });
    expect(wiredUiTools(advertised)).toContain('send_file');
    expect(missingUiCapabilities([])).not.toContain('send_file');
  });
});

describe('missingUiCapabilities', () => {
  it('lists only the decision-carrying tools that are absent', () => {
    expect(missingUiCapabilities([])).toEqual([
      'ask_user',
      'plan_approve',
      'request_review',
      'confirm',
    ]);
  });

  it('ignores the convenience tools', () => {
    expect(missingUiCapabilities(['ask_user', 'plan_approve', 'request_review', 'confirm'])).toEqual(
      [],
    );
  });
});
