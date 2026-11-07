import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ResolveContext } from '../language-resolvers';
import { resolveReferences } from '../resolver';
import { goResolver } from './go';
import { createHarness, type Harness } from '../test-support';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

function write(rel: string, content: string): void {
  const abs = path.join(h.root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

describe('go import resolution', () => {
  it('maps a module import path to the package directory and links package-qualified calls', async () => {
    write('go.mod', 'module example.com/m\n\ngo 1.22\n');
    await h.addFiles({
      'store/store.go': 'package store\n\nfunc New() int { return 1 }\n',
      'store/extra.go': 'package store\n\nfunc Extra() int { return 2 }\n',
      'store/store_test.go': 'package store\n\nfunc TestNew() {}\n',
      'main.go':
        'package main\n\nimport "example.com/m/store"\n\nfunc main() {\n\tstore.New()\n\tstore.Extra()\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('main.go'), 'imports').sort()).toEqual(
      [h.fileId('store/store.go'), h.fileId('store/extra.go')].sort(),
    );
    expect(
      h.targets(h.sym('main.go', 'main', 'function').id, 'calls').sort(),
    ).toEqual(
      [
        h.sym('store/store.go', 'New').id,
        h.sym('store/extra.go', 'Extra').id,
      ].sort(),
    );
  });

  it('honours import aliases', async () => {
    write('go.mod', 'module example.com/m\n');
    await h.addFiles({
      'store/store.go': 'package store\n\nfunc New() int { return 1 }\n',
      'main.go':
        'package main\n\nimport s "example.com/m/store"\n\nfunc main() {\n\ts.New()\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('main.go', 'main', 'function').id, 'calls')).toEqual(
      [h.sym('store/store.go', 'New').id],
    );
  });

  it('follows nested go.mod files and relative replace directives', async () => {
    write(
      'go.mod',
      'module example.com/m\n\nrequire example.com/lib v1.0.0\n\nreplace example.com/lib => ./third/lib\n',
    );
    write('svc/go.mod', 'module example.com/svc\n');
    write('third/lib/go.mod', 'module example.com/lib\n');
    await h.addFiles({
      'svc/api/api.go': 'package api\n\nfunc Serve() {}\n',
      'third/lib/lib.go': 'package lib\n\nfunc Do() {}\n',
      'main.go':
        'package main\n\nimport (\n\t"example.com/svc/api"\n\t"example.com/lib"\n)\n\nfunc main() {\n\tapi.Serve()\n\tlib.Do()\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.sym('main.go', 'main', 'function').id, 'calls').sort(),
    ).toEqual(
      [
        h.sym('svc/api/api.go', 'Serve').id,
        h.sym('third/lib/lib.go', 'Do').id,
      ].sort(),
    );
  });

  it('ignores replace directives that do not point at relative directories', async () => {
    write(
      'go.mod',
      'module example.com/m\n\nreplace example.com/x => github.com/fork/x v1.0.0\n',
    );
    await h.addFiles({
      'main.go':
        'package main\n\nimport "example.com/x"\n\nfunc main() {\n\tx.Do()\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('main.go'), 'imports')).toEqual([]);
  });

  it('respects internal/ visibility', async () => {
    write('go.mod', 'module example.com/m\n');
    await h.addFiles({
      'a/internal/x/x.go': 'package x\n\nfunc Do() {}\n',
      'a/use/use.go':
        'package use\n\nimport "example.com/m/a/internal/x"\n\nfunc Run() {\n\tx.Do()\n}\n',
      'b/main.go':
        'package main\n\nimport "example.com/m/a/internal/x"\n\nfunc main() {\n\tx.Do()\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('a/use/use.go'), 'imports')).toEqual([
      h.fileId('a/internal/x/x.go'),
    ]);
    expect(h.targets(h.sym('a/use/use.go', 'Run').id, 'calls')).toEqual([
      h.sym('a/internal/x/x.go', 'Do').id,
    ]);
    expect(h.targets(h.fileId('b/main.go'), 'imports')).toEqual([]);
    expect(
      h.targets(h.sym('b/main.go', 'main', 'function').id, 'calls'),
    ).toEqual([]);
  });

  it('leaves stdlib and unknown external paths failed without throwing', async () => {
    write('go.mod', 'module example.com/m\n');
    await h.addFiles({
      'main.go':
        'package main\n\nimport (\n\t"fmt"\n\t"github.com/x/y"\n)\n\nfunc main() {\n\tfmt.Println(y.Z)\n}\n',
    });
    expect(() => resolveReferences(h.q, h.root)).not.toThrow();
    expect(h.targets(h.fileId('main.go'), 'imports')).toEqual([]);
    expect(h.failedRefs().length).toBeGreaterThanOrEqual(2);
  });

  it('indexes package files once instead of scanning per import', () => {
    const files: string[] = [];
    for (let i = 0; i < 200; i++) files.push(`pkg${i}/p.go`);
    let listCalls = 0;
    const ctx: ResolveContext = {
      root: '/r',
      fileExists: (rel) => files.includes(rel),
      listFiles: () => {
        listCalls++;
        return files;
      },
      readText: (rel) => (rel === 'go.mod' ? 'module ex.com/m\n' : undefined),
    };
    for (let i = 0; i < 200; i++)
      expect(
        goResolver.resolveImportAll?.(
          'main.go',
          `ex.com/m/pkg${i}`,
          ctx,
          false,
        ),
      ).toEqual([`pkg${i}/p.go`]);
    expect(listCalls).toBeLessThanOrEqual(1);
  });
});
