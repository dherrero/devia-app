import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from '../resolver';
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

const USER = 'class User {\n  void hi() {}\n}\n';

describe('dart import resolution', () => {
  it('resolves package:<name>/ imports to lib/ and links instantiation', async () => {
    write('pubspec.yaml', 'name: app\nversion: 1.0.0\n');
    await h.addFiles({
      'lib/models/user.dart': USER,
      'lib/main.dart':
        "import 'package:app/models/user.dart';\n\nvoid main() {\n  User();\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('lib/main.dart'), 'imports')).toEqual([
      h.fileId('lib/models/user.dart'),
    ]);
    expect(
      h.targets(h.sym('lib/main.dart', 'main').id, 'instantiates'),
    ).toEqual([h.sym('lib/models/user.dart', 'User').id]);
  });

  it('resolves relative imports, including aliased ones', async () => {
    write('pubspec.yaml', 'name: app\n');
    await h.addFiles({
      'lib/models/user.dart': USER,
      'lib/ui/page.dart':
        "import '../models/user.dart' as m;\n\nvoid build() {\n  m.User();\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.sym('lib/ui/page.dart', 'build').id, 'instantiates'),
    ).toEqual([h.sym('lib/models/user.dart', 'User').id]);
  });

  it('links part and generated part files', async () => {
    write('pubspec.yaml', 'name: app\n');
    await h.addFiles({
      'lib/a.dart': "part 'a.g.dart';\n\nclass A {}\n",
      'lib/a.g.dart': "part of 'a.dart';\n\nclass B {}\n",
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('lib/a.dart'), 'imports')).toEqual([
      h.fileId('lib/a.g.dart'),
    ]);
    expect(h.targets(h.fileId('lib/a.g.dart'), 'imports')).toEqual([
      h.fileId('lib/a.dart'),
    ]);
  });

  it('supports monorepos with several pubspecs', async () => {
    write('packages/core/pubspec.yaml', 'name: core\n');
    write('packages/app/pubspec.yaml', 'name: "app"\n');
    await h.addFiles({
      'packages/core/lib/user.dart': USER,
      'packages/app/lib/main.dart':
        "import 'package:core/user.dart';\n\nvoid main() {\n  User();\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.fileId('packages/app/lib/main.dart'), 'imports'),
    ).toEqual([h.fileId('packages/core/lib/user.dart')]);
  });

  it('leaves dart:, flutter and unknown packages failed without throwing', async () => {
    write('pubspec.yaml', 'name: app\n');
    await h.addFiles({
      'lib/main.dart':
        "import 'dart:async';\nimport 'package:flutter/material.dart';\nimport 'package:other/x.dart';\nimport 'missing.dart';\n",
    });
    expect(() => resolveReferences(h.q, h.root)).not.toThrow();
    expect(h.targets(h.fileId('lib/main.dart'), 'imports')).toEqual([]);
    expect(h.failedRefs().length).toBe(4);
  });
});
