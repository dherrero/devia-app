import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncProject } from './sync';
import { fullIndex, fullIndexSnapshot, snapshotGraph, TestProject } from './sync-test-support';

let project: TestProject;
let dataDir: string;

beforeEach(() => {
  project = new TestProject();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-parity-sync-'));
});

afterEach(() => {
  project.dispose();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function syncAndCompare(step: string): Promise<void> {
  const result = await syncProject({ root: project.root, dataDir });
  expect(result.skippedBusy, step).toBe(false);
  expect(result.truncated, step).toBe(false);
  expect(result.fullIndexRequired, step).toBe(false);
  const synced = snapshotGraph(dataDir);
  const full = await fullIndexSnapshot(project.root);
  expect({ step, ...synced }).toEqual({ step, ...full });
}

const FIVE_LANGUAGES: Record<string, string> = {
  'ts/b.ts':
    "export function helper(x: number): number {\n  return x + 1;\n}\n\nexport class Base {\n  greet(): string {\n    return 'hi';\n  }\n}\n",
  'ts/a.ts':
    "import { helper, Base } from './b';\n\nexport class Child extends Base {\n  run(): number {\n    return helper(2) + this.greet().length;\n  }\n}\n\nexport function main(): number {\n  return new Child().run();\n}\n",
  'ts/c.ts': "import { main } from './a';\n\nexport const value = main();\n",
  'py/pkg/__init__.py': '',
  'py/pkg/util.py': "def helper(x):\n    return x + 1\n\n\nclass Base:\n    def greet(self):\n        return 'hi'\n",
  'py/pkg/app.py':
    'from .util import helper, Base\n\n\nclass Child(Base):\n    def run(self):\n        return helper(2) + len(self.greet())\n',
  'py/loose.py': 'def lonely():\n    return shared()\n',
  'py/shared_one.py': 'def shared():\n    return 1\n',
  'src/main/java/com/acme/Foo.java':
    'package com.acme;\n\npublic class Foo {\n  public int go() { return 1; }\n}\n',
  'src/main/java/com/app/Main.java':
    'package com.app;\n\nimport com.acme.Foo;\n\npublic class Main extends Foo {\n  int run() { return new Foo().go(); }\n}\n',
  'go.mod': 'module example.com/m\n',
  'store/store.go': 'package store\n\nfunc New() int { return 1 }\n',
  'main.go': 'package main\n\nimport "example.com/m/store"\n\nfunc main() {\n\tstore.New()\n\tstore.Extra()\n}\n',
  'shape/iface.go': 'package shape\n\ntype Reader interface {\n\tRead() int\n}\n',
  'shape/s.go': 'package shape\n\ntype S struct{}\n',
  'shape/s_read.go': 'package shape\n\nfunc (s *S) Read() int { return 1 }\n',
  'pubspec.yaml': 'name: app\n',
  'lib/models/user.dart': 'class User {\n  void hello() {}\n}\n',
  'lib/main.dart': "import 'package:app/models/user.dart';\n\nvoid main() {\n  User().hello();\n}\n",
};

describe('sync parity with a full reindex', () => {
  it('matches a fresh index after every step of a five-language edit sequence', async () => {
    project.writeAll(FIVE_LANGUAGES);
    await fullIndex(project.root, dataDir);
    const initial = snapshotGraph(dataDir);
    expect(initial).toEqual(await fullIndexSnapshot(project.root));
    expect(initial.edges.filter((e) => e.includes('"kind":"implements"') && e.includes('"provenance":"heuristic"'))).toHaveLength(1);
    const javaFoo = project.read('src/main/java/com/acme/Foo.java');

    project.write('ts/d.ts', "import { helper } from './b';\n\nexport function twice(): number {\n  return helper(helper(1));\n}\n");
    await syncAndCompare('add a file');

    project.write('py/pkg/util.py', "# shifted\ndef helper(x):\n    y = x * 2\n    return y + 1\n\n\nclass Base:\n    def greet(self):\n        return 'hello'\n");
    await syncAndCompare('modify a body (and shift lines)');

    project.write('ts/b.ts', project.read('ts/b.ts').replace('helper(x: number)', 'assist(x: number, y = 0)'));
    await syncAndCompare('modify a signature so callers lose their target');

    project.remove('src/main/java/com/acme/Foo.java');
    await syncAndCompare('delete a file others import and extend');

    project.rename('lib/models/user.dart', 'lib/models/person.dart');
    await syncAndCompare('rename a file');

    project.write('lib/main.dart', "import 'package:app/models/person.dart';\n\nvoid main() {\n  User().hello();\n}\n");
    await syncAndCompare('point the importer at the renamed file');

    project.write('src/main/java/com/acme/Foo.java', javaFoo);
    await syncAndCompare('re-create the deleted file with the same symbol');

    project.write('ts/a.ts', "import { helper, Base } from './b';\n\nexport class Child extends Base {\n  run(: number {\n    return helper(2);\n");
    await syncAndCompare('break a file with a syntax error');

    project.write('ts/a.ts', FIVE_LANGUAGES['ts/a.ts'] ?? '');
    project.write('ts/b.ts', FIVE_LANGUAGES['ts/b.ts'] ?? '');
    await syncAndCompare('fix the syntax error and restore the signature');

    project.touch('store/store.go');
    project.touch('py/pkg/app.py');
    await syncAndCompare('touch only mtimes');

    project.write('store/extra.go', 'package store\n\nfunc Extra() int { return 2 }\n');
    await syncAndCompare('add a file to an imported Go package');

    project.write('py/shared_two.py', 'def shared():\n    return 2\n');
    await syncAndCompare('make a project-wide name ambiguous');

    project.remove('py/shared_one.py');
    await syncAndCompare('make it unique again in another file');

    project.rename('ts/b.ts', 'ts/b/index.ts');
    await syncAndCompare('move a module into a directory index');

    project.remove('shape/s_read.go');
    await syncAndCompare('delete the file holding the method that made a Go struct implement an interface');

    project.write('shape/s_read.go', 'package shape\n\nfunc (s *S) Read() int { return 2 }\n');
    await syncAndCompare('bring the Go method back');
  });

  it('matches a fresh index after each of 30 seeded random edits over TS, Python and a Go package', async () => {
    const rand = mulberry32(0x5eed);
    const pick = <T>(items: readonly T[]): T => {
      const item = items[Math.floor(rand() * items.length)];
      if (item === undefined) throw new Error('empty pick');
      return item;
    };
    const NAMES = ['alpha', 'beta', 'gamma', 'delta', 'omega'] as const;
    const SLOTS = [
      'ts/m0.ts', 'ts/m1.ts', 'ts/m2.ts', 'ts/sub/m3.ts',
      'py/p0.py', 'py/p1.py', 'py/p2.py', 'py/sub/p3.py',
      'go/shape/iface.go', 'go/shape/s.go', 'go/shape/s_m.go', 'go/shape/t_m.go',
    ];
    const INITIAL = ['ts/m0.ts', 'ts/m1.ts', 'ts/m2.ts', 'py/p0.py', 'py/p1.py', 'py/p2.py', 'go/shape/iface.go', 'go/shape/s.go', 'go/shape/s_m.go'];
    const up = (n: string): string => `${n.charAt(0).toUpperCase()}${n.slice(1)}`;
    const present = (): string[] => SLOTS.filter((s) => project.exists(s));

    const content = (slot: string): string => {
      const others = present().filter((s) => s !== slot && s.endsWith(slot.endsWith('.ts') ? '.ts' : '.py'));
      const defs = [...new Set([pick(NAMES), pick(NAMES)])];
      const calls = [pick(NAMES), pick(NAMES)];
      if (slot.endsWith('.go')) {
        const lines = ['package shape'];
        if (slot.endsWith('iface.go') || rand() < 0.3)
          lines.push(`type I${up(pick(NAMES))} interface {\n${defs.map((d) => `\t${up(d)}() int`).join('\n')}\n}`);
        if (slot.endsWith('/s.go') || rand() < 0.3) lines.push(`type ${pick(['S', 'T'])} struct{}`);
        if (slot.endsWith('_m.go') || rand() < 0.3) {
          const recv = pick(['S', 'T']);
          for (const d of defs) lines.push(`func (r *${recv}) ${up(d)}() int { return ${up(pick(calls))}() }`);
        }
        return `${lines.join('\n\n')}\n`;
      }
      if (slot.endsWith('.ts')) {
        const lines: string[] = [];
        if (others.length > 0 && rand() < 0.7) {
          const from = path.posix.relative(path.posix.dirname(slot), pick(others)).replace(/\.ts$/, '');
          lines.push(`import { ${pick(NAMES)} } from '${from.startsWith('.') ? from : `./${from}`}';`);
        }
        for (const d of defs) lines.push(`export function ${d}(): number {\n  return ${calls.map((c) => `${c}()`).join(' + ')};\n}`);
        if (rand() < 0.4) lines.push(`export class K${pick(NAMES)} {\n  run(): number {\n    return ${pick(NAMES)}();\n  }\n}`);
        return `${lines.join('\n\n')}\n`;
      }
      const lines: string[] = [];
      if (others.length > 0 && rand() < 0.5) {
        const mod = pick(others).replace(/\.py$/, '').split('/').join('.');
        lines.push(`from ${mod} import ${pick(NAMES)}`);
      }
      for (const d of defs) lines.push(`def ${d}():\n    return ${calls.map((c) => `${c}()`).join(' + ')}\n`);
      if (rand() < 0.4) lines.push(`class K${pick(NAMES)}:\n    def run(self):\n        return ${pick(NAMES)}()\n`);
      return `${lines.join('\n\n')}\n`;
    };

    project.writeAll({ 'py/__init__.py': '', 'py/sub/__init__.py': '', 'go.mod': 'module example.com/m\n' });
    for (const slot of INITIAL) project.write(slot, content(slot));
    await fullIndex(project.root, dataDir);

    for (let step = 0; step < 30; step++) {
      const existing = present();
      const missing = SLOTS.filter((s) => !existing.includes(s));
      const op = pick(['add', 'modify', 'modify', 'delete', 'rename', 'break', 'touch'] as const);
      let label: string;
      if ((op === 'add' || existing.length < 2) && missing.length > 0) {
        const slot = pick(missing);
        project.write(slot, content(slot));
        label = `add ${slot}`;
      } else if (op === 'delete') {
        const slot = pick(existing);
        project.remove(slot);
        label = `delete ${slot}`;
      } else if (op === 'rename' && missing.length > 0) {
        const from = pick(existing);
        const targets = missing.filter((m) => path.extname(m) === path.extname(from));
        if (targets.length > 0) {
          const to = pick(targets);
          project.rename(from, to);
          label = `rename ${from} -> ${to}`;
        } else {
          project.write(from, content(from));
          label = `modify ${from}`;
        }
      } else if (op === 'break') {
        const slot = pick(existing);
        const junk = slot.endsWith('.ts') ? 'export function (' : slot.endsWith('.go') ? 'func (' : 'def broken(:\n';
        project.write(slot, `${project.read(slot)}${junk}`);
        label = `break ${slot}`;
      } else if (op === 'touch') {
        const slot = pick(existing);
        project.touch(slot);
        label = `touch ${slot}`;
      } else {
        const slot = pick(existing);
        project.write(slot, content(slot));
        label = `modify ${slot}`;
      }
      await syncAndCompare(`step ${step}: ${label}`);
    }
  }, 60_000);
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
