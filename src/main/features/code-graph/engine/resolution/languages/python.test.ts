import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from '../resolver';
import { createHarness, type Harness } from '../test-support';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

describe('python import resolution', () => {
  it('resolves a relative from-import and links the call', async () => {
    await h.addFiles({
      'pkg/__init__.py': '',
      'pkg/a.py': 'from .utils import helper\n\ndef run():\n    helper()\n',
      'pkg/utils.py': 'def helper():\n    pass\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('pkg/a.py'), 'imports')).toContain(
      h.fileId('pkg/utils.py'),
    );
    expect(h.targets(h.sym('pkg/a.py', 'run').id, 'calls')).toEqual([
      h.sym('pkg/utils.py', 'helper').id,
    ]);
  });

  it('resolves `from . import y` as a submodule before the package init', async () => {
    await h.addFiles({
      'pkg/__init__.py': 'def y():\n    pass\n',
      'pkg/b.py': 'from . import y\n\ndef f():\n    y.g()\n',
      'pkg/y.py': 'def g():\n    pass\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('pkg/b.py', 'f').id, 'calls')).toEqual([
      h.sym('pkg/y.py', 'g').id,
    ]);
  });

  it('falls back to a symbol in __init__.py for `from . import y`', async () => {
    await h.addFiles({
      'pkg/__init__.py': 'def y():\n    pass\n',
      'pkg/b.py': 'from . import y\n\ndef f():\n    y()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('pkg/b.py', 'f').id, 'calls')).toEqual([
      h.sym('pkg/__init__.py', 'y').id,
    ]);
  });

  it('goes up one package per extra dot', async () => {
    await h.addFiles({
      'pkg/__init__.py': '',
      'pkg/x.py': 'def z():\n    pass\n',
      'pkg/sub/__init__.py': '',
      'pkg/sub/c.py': 'from ..x import z\n\ndef f():\n    z()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('pkg/sub/c.py', 'f').id, 'calls')).toEqual([
      h.sym('pkg/x.py', 'z').id,
    ]);
  });

  it('resolves absolute imports under src/ and the project root', async () => {
    await h.addFiles({
      'src/app/__init__.py': '',
      'src/app/core.py': 'def boot():\n    pass\n',
      'tools/run.py': 'import app.core\n\ndef go():\n    app.core.boot()\n',
      'main.py': 'from app.core import boot\n\ndef m():\n    boot()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('tools/run.py'), 'imports')).toEqual([
      h.fileId('src/app/core.py'),
    ]);
    expect(h.targets(h.sym('tools/run.py', 'go').id, 'calls')).toEqual([
      h.sym('src/app/core.py', 'boot').id,
    ]);
    expect(h.targets(h.sym('main.py', 'm').id, 'calls')).toEqual([
      h.sym('src/app/core.py', 'boot').id,
    ]);
  });

  it('falls back to the package __init__ when the dotted tail is an attribute', async () => {
    await h.addFiles({
      'lib/__init__.py': 'class Thing:\n    pass\n',
      'main.py': 'import lib.Thing\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('main.py'), 'imports')).toEqual([
      h.fileId('lib/__init__.py'),
    ]);
  });

  it('leaves external and stdlib imports failed without throwing', async () => {
    await h.addFiles({
      'main.py': 'import os\nimport requests\nfrom ..far import q\n',
    });
    expect(() => resolveReferences(h.q, h.root)).not.toThrow();
    expect(h.targets(h.fileId('main.py'), 'imports')).toEqual([]);
    expect(h.failedRefs().length).toBeGreaterThanOrEqual(3);
  });

  it('resolves a.b.f() but not a.x() into a submodule after `import a.b`', async () => {
    await h.addFiles({
      'a/__init__.py': '',
      'a/b.py': 'def f():\n    pass\n\ndef x():\n    pass\n',
      'main.py': 'import a.b\n\ndef m():\n    a.b.f()\n    a.x()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('main.py', 'm').id, 'calls')).toEqual([
      h.sym('a/b.py', 'f').id,
    ]);
  });

  it('does not bind the bare name to a submodule without an __init__', async () => {
    await h.addFiles({
      'a/b.py': 'def x():\n    pass\n',
      'main.py': 'import a.b\n\ndef m():\n    a.x()\n    a.b.x()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('main.py', 'm').id, 'calls')).toEqual([
      h.sym('a/b.py', 'x').id,
    ]);
  });

  it('keeps two dotted imports of the same package from clobbering each other', async () => {
    await h.addFiles({
      'a/__init__.py': 'def run():\n    pass\n',
      'a/b.py': 'def run():\n    pass\n',
      'a/c.py': 'def run():\n    pass\n',
      'main.py':
        'import a.b\nimport a.c\n\ndef m():\n    a.run()\n    a.b.run()\n    a.c.run()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('main.py', 'm').id, 'calls').sort()).toEqual(
      [
        h.sym('a/__init__.py', 'run').id,
        h.sym('a/b.py', 'run').id,
        h.sym('a/c.py', 'run').id,
      ].sort(),
    );
  });

  it('binds an alias of a dotted import to the submodule', async () => {
    await h.addFiles({
      'a/__init__.py': '',
      'a/b.py': 'def f():\n    pass\n',
      'main.py': 'import a.b as c\n\ndef m():\n    c.f()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.sym('main.py', 'm').id, 'calls')).toEqual([
      h.sym('a/b.py', 'f').id,
    ]);
  });

  it('tries only __init__.py for a bare `.` import, not a sibling pkg.py', async () => {
    await h.addFiles({
      'pkg.py': 'def y():\n    pass\n',
      'pkg/b.py': 'from . import y\n\ndef f():\n    y()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('pkg/b.py'), 'imports')).toEqual([]);
    expect(h.targets(h.sym('pkg/b.py', 'f').id, 'calls')).toEqual([]);
  });

  it('imports the package __init__ as well as the submodule for `from pkg import sub`', async () => {
    await h.addFiles({
      'pkg/__init__.py': '',
      'pkg/sub.py': 'def g():\n    pass\n',
      'pkg/other/__init__.py': '',
      'pkg/other/c.py': 'from .. import sub\n',
      'main.py': 'from pkg import sub\n\ndef m():\n    sub.g()\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('main.py'), 'imports').sort()).toEqual(
      [h.fileId('pkg/__init__.py'), h.fileId('pkg/sub.py')].sort(),
    );
    expect(h.targets(h.fileId('pkg/other/c.py'), 'imports').sort()).toEqual(
      [h.fileId('pkg/__init__.py'), h.fileId('pkg/sub.py')].sort(),
    );
    expect(h.targets(h.sym('main.py', 'm').id, 'calls')).toEqual([
      h.sym('pkg/sub.py', 'g').id,
    ]);
  });

  it('does not add a package edge for `from pkg.mod import name`', async () => {
    await h.addFiles({
      'pkg/__init__.py': '',
      'pkg/mod.py': 'def g():\n    pass\n',
      'main.py': 'from pkg.mod import g\n',
    });
    resolveReferences(h.q, h.root);
    expect(h.targets(h.fileId('main.py'), 'imports')).toEqual([
      h.fileId('pkg/mod.py'),
    ]);
  });
});
