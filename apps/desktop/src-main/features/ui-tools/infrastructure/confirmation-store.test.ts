import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfirmationStore, normalizeAction } from './confirmation-store';

let deviaDir = '';
let store: ConfirmationStore;
const PROJECT = '/ws/proj-a';

beforeEach(() => {
  deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-confirm-'));
  store = new ConfirmationStore(() => deviaDir);
});

afterEach(() => {
  fs.rmSync(deviaDir, { recursive: true, force: true });
});

describe('normalizeAction', () => {
  it('folds case and collapses whitespace, and nothing else', () => {
    expect(normalizeAction('  RM  -RF   dist ')).toBe('rm -rf dist');
    expect(normalizeAction('rm -rf dist')).toBe('rm -rf dist');
  });

  it('keeps every other character significant', () => {
    expect(normalizeAction('rm -rf dist/')).not.toBe(normalizeAction('rm -rf dist'));
  });
});

describe('grant matching', () => {
  it('matches only the exact normalised action', () => {
    store.grant(PROJECT, 'rm -rf node_modules');

    expect(store.isGranted(PROJECT, 'rm -rf node_modules')).toBe(true);
    expect(store.isGranted(PROJECT, 'RM -RF   node_modules')).toBe(true);
  });

  it('NEVER matches by prefix — the whole point of the rule', () => {
    store.grant(PROJECT, 'rm -rf node_modules');

    expect(store.isGranted(PROJECT, 'rm -rf /')).toBe(false);
    expect(store.isGranted(PROJECT, 'rm -rf node_modules && rm -rf /')).toBe(false);
    expect(store.isGranted(PROJECT, 'rm -rf')).toBe(false);
  });

  it('is scoped per project', () => {
    store.grant(PROJECT, 'git push --force');

    expect(store.isGranted('/ws/other', 'git push --force')).toBe(false);
  });

  it('ignores an empty action', () => {
    store.grant(PROJECT, '   ');
    expect(store.list(PROJECT)).toEqual([]);
    expect(store.isGranted(PROJECT, '')).toBe(false);
  });
});

describe('lifecycle', () => {
  it('does not duplicate a grant', () => {
    store.grant(PROJECT, 'git push --force');
    store.grant(PROJECT, 'GIT PUSH --force');

    expect(store.list(PROJECT)).toHaveLength(1);
  });

  it('keeps the label the user saw plus who asked', () => {
    store.grant(PROJECT, '  Git Push --force ', 'codex');
    const [grant] = store.list(PROJECT);

    expect(grant?.label).toBe('Git Push --force');
    expect(grant?.action).toBe('git push --force');
    expect(grant?.agentId).toBe('codex');
    expect(Number.isNaN(Date.parse(grant?.grantedAt ?? ''))).toBe(false);
  });

  it('revokes one grant and leaves the rest', () => {
    store.grant(PROJECT, 'a');
    store.grant(PROJECT, 'b');
    store.revoke(PROJECT, 'A');

    expect(store.list(PROJECT).map((g) => g.action)).toEqual(['b']);
  });

  it('revokes everything at once', () => {
    store.grant(PROJECT, 'a');
    store.grant(PROJECT, 'b');
    store.revokeAll(PROJECT);

    expect(store.list(PROJECT)).toEqual([]);
  });

  it('a revocation takes effect on the very next read — there is no cache', () => {
    store.grant(PROJECT, 'a');
    // Simulate the settings panel writing through another instance.
    new ConfirmationStore(() => deviaDir).revoke(PROJECT, 'a');

    expect(store.isGranted(PROJECT, 'a')).toBe(false);
  });
});

describe('defensive reads', () => {
  it('treats a missing file as no grants', () => {
    expect(store.list(PROJECT)).toEqual([]);
    expect(store.isGranted(PROJECT, 'anything')).toBe(false);
  });

  it('treats a corrupt file as no grants instead of throwing', () => {
    const file = store.fileFor(PROJECT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json', 'utf8');

    expect(store.list(PROJECT)).toEqual([]);
  });

  it('drops malformed entries but keeps the valid ones', () => {
    const file = store.fileFor(PROJECT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ grants: [{ nope: 1 }, { action: 'a', label: 'a' }, null] }),
      'utf8',
    );

    expect(store.list(PROJECT).map((g) => g.action)).toEqual(['a']);
  });

  it('never leaves a temp file behind', () => {
    store.grant(PROJECT, 'a');
    const dir = path.dirname(store.fileFor(PROJECT));

    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});
