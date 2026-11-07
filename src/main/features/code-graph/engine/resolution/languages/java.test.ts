import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from '../resolver';
import { createHarness, type Harness } from '../test-support';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const FOO = 'package com.acme;\npublic class Foo {\n  public void hi() {}\n}\n';

describe('java import resolution', () => {
  it('resolves an FQN to the file under src/main/java and links instantiation', async () => {
    await h.addFiles({
      'src/main/java/com/acme/Foo.java': FOO,
      'src/main/java/com/app/Main.java':
        'package com.app;\nimport com.acme.Foo;\npublic class Main {\n  void run() { new Foo(); }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.fileId('src/main/java/com/app/Main.java'), 'imports'),
    ).toEqual([h.fileId('src/main/java/com/acme/Foo.java')]);
    expect(
      h.targets(
        h.sym('src/main/java/com/app/Main.java', 'Main.run').id,
        'instantiates',
      ),
    ).toEqual([h.sym('src/main/java/com/acme/Foo.java', 'Foo').id]);
  });

  it('resolves a star import to every file of the package', async () => {
    await h.addFiles({
      'src/main/java/com/acme/Foo.java': FOO,
      'src/main/java/com/acme/Bar.java':
        'package com.acme;\npublic class Bar {}\n',
      'src/main/java/com/app/Main.java':
        'package com.app;\nimport com.acme.*;\npublic class Main {\n  void run() { new Bar(); }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.fileId('src/main/java/com/app/Main.java'), 'imports').sort(),
    ).toEqual(
      [
        h.fileId('src/main/java/com/acme/Foo.java'),
        h.fileId('src/main/java/com/acme/Bar.java'),
      ].sort(),
    );
    expect(
      h.targets(
        h.sym('src/main/java/com/app/Main.java', 'Main.run').id,
        'instantiates',
      ),
    ).toEqual([h.sym('src/main/java/com/acme/Bar.java', 'Bar').id]);
  });

  it('resolves a static import to the class file and its member', async () => {
    await h.addFiles({
      'src/main/java/com/acme/Util.java':
        'package com.acme;\npublic class Util {\n  public static void help() {}\n}\n',
      'src/main/java/com/app/Main.java':
        'package com.app;\nimport static com.acme.Util.help;\npublic class Main {\n  void run() { help(); }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.fileId('src/main/java/com/app/Main.java'), 'imports'),
    ).toEqual([h.fileId('src/main/java/com/acme/Util.java')]);
    expect(
      h.targets(
        h.sym('src/main/java/com/app/Main.java', 'Main.run').id,
        'calls',
      ),
    ).toEqual([h.sym('src/main/java/com/acme/Util.java', 'Util.help').id]);
  });

  it('resolves a nested-class import to the outer class file', async () => {
    await h.addFiles({
      'src/main/java/com/acme/Outer.java':
        'package com.acme;\npublic class Outer {\n  public static class Inner {}\n}\n',
      'src/main/java/com/app/Main.java':
        'package com.app;\nimport com.acme.Outer.Inner;\npublic class Main {\n  void run() { new Inner(); }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.fileId('src/main/java/com/app/Main.java'), 'imports'),
    ).toEqual([h.fileId('src/main/java/com/acme/Outer.java')]);
    expect(
      h.targets(
        h.sym('src/main/java/com/app/Main.java', 'Main.run').id,
        'instantiates',
      ),
    ).toEqual([h.sym('src/main/java/com/acme/Outer.java', 'Outer.Inner').id]);
  });

  it('leaves JDK imports failed without throwing', async () => {
    await h.addFiles({
      'src/main/java/com/app/Main.java':
        'package com.app;\nimport java.util.List;\nimport java.util.*;\npublic class Main {}\n',
    });
    expect(() => resolveReferences(h.q, h.root)).not.toThrow();
    expect(
      h.targets(h.fileId('src/main/java/com/app/Main.java'), 'imports'),
    ).toEqual([]);
    expect(h.failedRefs().length).toBe(2);
  });

  it('prefers the importing module and drops cross-module ambiguity', async () => {
    await h.addFiles({
      'a/src/main/java/com/acme/Foo.java': FOO,
      'b/src/main/java/com/acme/Foo.java': FOO,
      'a/src/main/java/com/app/Main.java':
        'package com.app;\nimport com.acme.Foo;\npublic class Main {}\n',
      'c/src/main/java/com/app/Other.java':
        'package com.app;\nimport com.acme.Foo;\npublic class Other {}\n',
    });
    resolveReferences(h.q, h.root);
    expect(
      h.targets(h.fileId('a/src/main/java/com/app/Main.java'), 'imports'),
    ).toEqual([h.fileId('a/src/main/java/com/acme/Foo.java')]);
    expect(
      h.targets(h.fileId('c/src/main/java/com/app/Other.java'), 'imports'),
    ).toEqual([]);
  });
});
