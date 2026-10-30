import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { SnapshotStore } from '../infrastructure/snapshot-store';
import { SnapshotCreateUseCase } from './snapshot-create.use-case';
import { SnapshotRestoreUseCase } from './snapshot-restore.use-case';
import { SnapshotRetentionUseCase } from './snapshot-retention.use-case';
import { SnapshotListUseCase } from './snapshot-list.use-case';

/**
 * End-to-end tests for the create/restore/retention/dedup pipeline.
 */

function makeFixture(): { deviaDir: string; workspace: string; cleanup: () => void } {
  const deviaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-snap-rt-'));
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'devia-snap-rt-ws-'));
  return {
    deviaDir,
    workspace,
    cleanup() {
      fs.rmSync(deviaDir, { recursive: true, force: true });
      fs.rmSync(workspace, { recursive: true, force: true });
    },
  };
}

function build(deviaDir: string) {
  const store = new SnapshotStore(() => deviaDir);
  const retention = new SnapshotRetentionUseCase(store);
  const create = new SnapshotCreateUseCase(store, retention);
  const restore = new SnapshotRestoreUseCase(store);
  const list = new SnapshotListUseCase(store);
  return { store, retention, create, restore, list };
}

function expectPresent<T>(value: T | null | undefined): T {
  expect(value).toBeDefined();
  return value as T;
}

describe('create + restore round-trip', () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('restores the original content byte-for-byte', () => {
    const target = path.join(fx.workspace, 'cfg.json');
    fs.writeFileSync(target, '{"first":true}', 'utf8');
    const original = fs.readFileSync(target);

    const { create, restore } = build(fx.deviaDir);
    const snap = create.execute({
      feature: 'skills',
      reason: 'before mutation',
      paths: [target],
    });
    expect(snap.deduped).toBe(false);

    // Mutate the file.
    fs.writeFileSync(target, '{"second":false}', 'utf8');

    const result = restore.execute('skills', snap.id);
    expect(result.failed).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.restored).toEqual([target]);
    expect(fs.readFileSync(target).equals(original)).toBe(true);
  });

  it('re-deletes files the destructive op created', () => {
    const futureFile = path.join(fx.workspace, 'created-later.txt');
    const { create, restore } = build(fx.deviaDir);
    const snap = create.execute({
      feature: 'manual',
      reason: 'before specify init',
      paths: [futureFile],
    });

    fs.writeFileSync(futureFile, 'created by op', 'utf8');
    expect(fs.existsSync(futureFile)).toBe(true);

    const result = restore.execute('manual', snap.id);
    expect(result.failed).toEqual([]);
    expect(result.restored).toEqual([futureFile]);
    expect(fs.existsSync(futureFile)).toBe(false);
  });

  it('default restore overwrites unconditionally', () => {
    const target = path.join(fx.workspace, 'unsafe.json');
    fs.writeFileSync(target, 'before', 'utf8');

    const { create, restore } = build(fx.deviaDir);
    const snap = create.execute({ feature: 'mcp', reason: 'r', paths: [target] });

    // Whatever the file looks like at restore time, default restore
    // (no `safe` flag) rolls it back to the snapshot content.
    fs.writeFileSync(target, 'manually edited', 'utf8');
    const result = restore.execute('mcp', snap.id);
    expect(result.failed).toEqual([]);
    expect(result.drift).toEqual([]);
    expect(result.restored).toEqual([target]);
    expect(fs.readFileSync(target, 'utf8')).toBe('before');
  });

  it('safe restore reports drift instead of overwriting', () => {
    const target = path.join(fx.workspace, 'safe.json');
    fs.writeFileSync(target, 'before', 'utf8');

    const { create, restore } = build(fx.deviaDir);
    const snap = create.execute({ feature: 'mcp', reason: 'r', paths: [target] });

    // User edited after snapshot — safe restore must report drift.
    fs.writeFileSync(target, 'user edit', 'utf8');
    const result = restore.execute('mcp', snap.id, { safe: true });
    expect(result.restored).toEqual([]);
    expect(result.drift).toHaveLength(1);
    expect(result.drift[0]?.path).toBe(target);
    expect(fs.readFileSync(target, 'utf8')).toBe('user edit');
  });
});

describe('dedup', () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('two consecutive create() with identical input return the same id', () => {
    const target = path.join(fx.workspace, 'cfg.json');
    fs.writeFileSync(target, '{"same":true}', 'utf8');

    const { create } = build(fx.deviaDir);
    const a = create.execute({ feature: 'skills', reason: 'r', paths: [target] });
    const b = create.execute({ feature: 'skills', reason: 'r', paths: [target] });

    expect(a.deduped).toBe(false);
    expect(b.deduped).toBe(true);
    expect(b.id).toBe(a.id);
  });

  it('different reason → fresh snapshot even with same content', () => {
    const target = path.join(fx.workspace, 'cfg.json');
    fs.writeFileSync(target, 'x', 'utf8');

    const { create } = build(fx.deviaDir);
    const a = create.execute({ feature: 'skills', reason: 'first', paths: [target] });
    const b = create.execute({ feature: 'skills', reason: 'second', paths: [target] });

    expect(a.id).not.toBe(b.id);
  });

  it('mutated content → fresh snapshot', () => {
    const target = path.join(fx.workspace, 'cfg.json');
    fs.writeFileSync(target, 'before', 'utf8');

    const { create } = build(fx.deviaDir);
    const a = create.execute({ feature: 'skills', reason: 'r', paths: [target] });
    fs.writeFileSync(target, 'after', 'utf8');
    const b = create.execute({ feature: 'skills', reason: 'r', paths: [target] });

    expect(a.id).not.toBe(b.id);
  });
});

describe('retention', () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('keeps only the last N unpinned snapshots per feature', () => {
    const { store, list } = build(fx.deviaDir);
    // Manually drop the retention cap so the test stays fast.
    const tightRetention = new SnapshotRetentionUseCase(store, {
      maxPerFeature: 3,
      maxAgeDays: 30,
    });
    const tightCreate = new SnapshotCreateUseCase(store, tightRetention);

    for (let i = 0; i < 6; i++) {
      const f = path.join(fx.workspace, `c${i}.txt`);
      fs.writeFileSync(f, String(i), 'utf8');
      tightCreate.execute({ feature: 'skills', reason: `r${i}`, paths: [f] });
    }

    const surviving = list.execute({ feature: 'skills' });
    expect(surviving.length).toBe(3);
  });

  it('pinned snapshots survive the retention sweep', () => {
    const { store } = build(fx.deviaDir);
    const tightRetention = new SnapshotRetentionUseCase(store, {
      maxPerFeature: 2,
      maxAgeDays: 30,
    });
    const tightCreate = new SnapshotCreateUseCase(store, tightRetention);

    // Create the snapshot we want to protect and pin it immediately —
    // before further creates trigger retention sweeps. This matches
    // the real-world flow: user pins from the history modal.
    const protectedFile = path.join(fx.workspace, 'protected.txt');
    fs.writeFileSync(protectedFile, 'keep-me', 'utf8');
    const protectedId = tightCreate.execute({
      feature: 'skills',
      reason: 'pinned',
      paths: [protectedFile],
    }).id;
    const first = expectPresent(store.readManifestById('skills', protectedId));
    store.writeManifest({ ...first, pinned: true });

    // Now create N more unpinned snapshots; retention runs after each
    // and would prune the pinned one if pin protection didn't work.
    for (let i = 0; i < 5; i++) {
      const f = path.join(fx.workspace, `c${i}.txt`);
      fs.writeFileSync(f, String(i), 'utf8');
      tightCreate.execute({ feature: 'skills', reason: `r${i}`, paths: [f] });
    }

    const survivors = store.listManifests('skills');
    expect(survivors.some((m) => m.id === protectedId)).toBe(true);
  });
});

describe('list use case', () => {
  let fx: ReturnType<typeof makeFixture>;
  beforeEach(() => { fx = makeFixture(); });
  afterEach(() => fx.cleanup());

  it('returns summaries sorted newest first', async () => {
    const { create, list } = build(fx.deviaDir);
    const f1 = path.join(fx.workspace, 'a.txt');
    fs.writeFileSync(f1, 'a', 'utf8');
    create.execute({ feature: 'mcp', reason: 'first', paths: [f1] });

    await new Promise((r) => setTimeout(r, 5));

    const f2 = path.join(fx.workspace, 'b.txt');
    fs.writeFileSync(f2, 'b', 'utf8');
    create.execute({ feature: 'mcp', reason: 'second', paths: [f2] });

    const summaries = list.execute({ feature: 'mcp' });
    expect(summaries.map((s) => s.reason)).toEqual(['second', 'first']);
  });

  it('filters by projectPath', () => {
    const { create, list } = build(fx.deviaDir);
    const a = path.join(fx.workspace, 'a.txt');
    const b = path.join(fx.workspace, 'b.txt');
    fs.writeFileSync(a, 'a', 'utf8');
    fs.writeFileSync(b, 'b', 'utf8');
    create.execute({ feature: 'skills', reason: 'p1', paths: [a], projectPath: '/proj/one' });
    create.execute({ feature: 'skills', reason: 'p2', paths: [b], projectPath: '/proj/two' });

    const summaries = list.execute({ projectPath: '/proj/one' });
    expect(summaries.map((s) => s.reason)).toEqual(['p1']);
  });
});
