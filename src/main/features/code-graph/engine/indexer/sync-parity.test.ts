import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

  it('matches a fresh index when receiver types change in files the caller never imports (T-515)', async () => {
    const RECEIVERS: Record<string, string> = {
      'src/models/user.ts': 'export class User {\n  hello(): void {}\n}\nexport class Other {\n  hello(): void {}\n}\n',
      'src/models/index.ts': "export { User, Other } from './user';\n",
      'src/user-service.ts':
        "import { User } from './models';\nexport class UserService {\n  find(): User {\n    return new User();\n  }\n}\n",
      'src/repo.ts': 'export class Repo<T> {\n  get(): T {\n    throw new Error();\n  }\n}\n',
      'src/app.ts':
        "import { UserService } from './user-service';\nimport { Repo } from './repo';\nimport type { User } from './models';\nexport class App {\n  private repo = new Repo<User>();\n  constructor(private readonly users: UserService) {}\n  run(): void {\n    this.users.find().hello();\n    const u = this.repo.get();\n    u.hello();\n  }\n}\n",
    };
    project.writeAll(RECEIVERS);
    await fullIndex(project.root, dataDir);
    const initial = snapshotGraph(dataDir);
    // find, get and hello twice: both receivers resolved.
    expect(initial.edges.filter((e) => e.includes('"kind":"calls"'))).toHaveLength(4);

    project.write('src/models/index.ts', "export { Other } from './user';\n");
    await syncAndCompare('a re-export the declaring file relies on disappears');

    project.write('src/models/index.ts', RECEIVERS['src/models/index.ts'] ?? '');
    await syncAndCompare('the re-export comes back');

    project.write('src/repo.ts', 'export class Repo<T> {\n  get() {\n    throw new Error();\n  }\n}\n');
    await syncAndCompare('a generic return type is dropped');

    project.write('src/repo.ts', RECEIVERS['src/repo.ts'] ?? '');
    await syncAndCompare('the generic return type comes back');

    project.write('src/user-service.ts', (RECEIVERS['src/user-service.ts'] ?? '').replace('find(): User', 'find(): Other').replace("{ User }", '{ Other, User }'));
    await syncAndCompare('a declared return type changes');

    project.write('src/models/user.ts', 'export class User {\n  hi(): void {}\n}\nexport class Other {\n  bye(): void {}\n}\n');
    await syncAndCompare('the target methods are renamed');

    // The caller reaches bus.ts only through a re-export and has no edge into it: only the
    // recorded receiver dependencies can tell that its field types matter.
    project.writeAll({
      'src/log.ts': 'export class Logger {\n  info(): void {}\n}\nexport class Audit {\n  info(): void {}\n}\n',
      'src/bus.ts': "import { Logger, Audit } from './log';\nexport class Bus {\n  readonly sink: Logger = new Logger();\n}\n",
      'src/hub.ts': "export { Bus } from './bus';\n",
      'src/main.ts': "import { Bus } from './hub';\nexport function main(bus: Bus): void {\n  bus.sink.info();\n}\n",
    });
    await syncAndCompare('add a field-typed receiver chain');
    project.write('src/bus.ts', (project.read('src/bus.ts')).replace('sink: Logger = new Logger()', 'sink: Audit = new Audit()'));
    await syncAndCompare('the field type changes in a file the caller does not import');
  });

  it('matches a fresh index when Java receiver types change (T-515)', async () => {
    const P = 'src/main/java/com/acme';
    project.writeAll({
      [`${P}/model/Identified.java`]: 'package com.acme.model;\npublic interface Identified {\n  String getId();\n}\n',
      [`${P}/model/Order.java`]:
        'package com.acme.model;\npublic class Order implements Identified {\n  public String getId() {\n    return "";\n  }\n  public void markPaid() {}\n}\n',
      [`${P}/service/Repo.java`]:
        'package com.acme.service;\nimport com.acme.model.Identified;\npublic class Repo<T extends Identified> {\n  public T get(String id) {\n    return null;\n  }\n  public void save(T item) {\n    item.getId();\n  }\n}\n',
      [`${P}/service/Audit.java`]: 'package com.acme.service;\npublic class Audit {\n  public void log() {}\n}\n',
      [`${P}/service/OrderService.java`]:
        'package com.acme.service;\nimport com.acme.model.Order;\npublic class OrderService {\n  private final Repo<Order> repo = new Repo<>();\n  private Audit audit;\n  public void pay(String id) {\n    Order o = repo.get(id);\n    o.markPaid();\n    for (Order each : java.util.List.of(o)) each.getId();\n    audit.log();\n  }\n}\n',
    });
    await fullIndex(project.root, dataDir);
    const initial = snapshotGraph(dataDir);
    // getId (bound), get, markPaid, getId (for), log.
    expect(initial.edges.filter((e) => e.includes('"kind":"calls"'))).toHaveLength(5);

    project.write(`${P}/service/Repo.java`, project.read(`${P}/service/Repo.java`).replace('public T get', 'public Identified get'));
    await syncAndCompare('a generic return type becomes the bound type');

    project.write(`${P}/service/Repo.java`, project.read(`${P}/service/Repo.java`).replace('T extends Identified', 'T'));
    await syncAndCompare('the type parameter bound is dropped');

    project.remove(`${P}/service/Audit.java`);
    await syncAndCompare('a same-package field type disappears');

    project.write(`${P}/service/Audit.java`, 'package com.acme.service;\npublic class Audit {\n  public void log() {}\n}\n');
    await syncAndCompare('the same-package field type comes back');

    project.write(`${P}/model/Order.java`, project.read(`${P}/model/Order.java`).replace('markPaid', 'settle'));
    await syncAndCompare('the target method is renamed');
  });

  it('matches a fresh index when Go receiver types change (T-515)', async () => {
    project.writeAll({
      'go.mod': 'module example.com/m\n',
      'model/model.go':
        'package model\n\ntype base struct{}\n\nfunc (b base) ID() string { return "" }\n\ntype User struct {\n\tbase\n}\n\nfunc (u *User) Hello() {}\n',
      'core/logger.go':
        'package core\n\ntype Logger struct{}\n\nfunc NewLogger() *Logger { return &Logger{} }\n\nfunc (l *Logger) Info() {}\n',
      'service/users.go':
        'package service\n\nimport (\n\t"example.com/m/core"\n\t"example.com/m/model"\n)\n\ntype Users struct {\n\tlog *core.Logger\n}\n\nfunc (s *Users) Find(id string) (*model.User, error) {\n\treturn nil, nil\n}\n',
      'main.go':
        'package main\n\nimport (\n\t"example.com/m/core"\n\t"example.com/m/service"\n)\n\nfunc run(s *service.Users) {\n\tu, _ := s.Find("1")\n\tu.Hello()\n\tu.ID()\n\tlog := core.NewLogger()\n\tlog.Info()\n}\n',
    });
    await fullIndex(project.root, dataDir);
    const initial = snapshotGraph(dataDir);
    // Find, Hello, ID (promoted), NewLogger, Info.
    expect(initial.edges.filter((e) => e.includes('"kind":"calls"'))).toHaveLength(5);

    project.write('model/model.go', project.read('model/model.go').replace('\tbase\n', '\tName string\n'));
    await syncAndCompare('the embedding that promotes ID is removed');

    project.write('model/model.go', project.read('model/model.go').replace('\tName string\n', '\tbase\n'));
    await syncAndCompare('the embedding comes back');

    project.write('service/users.go', project.read('service/users.go').replace('(*model.User, error)', '(any, error)'));
    await syncAndCompare('a declared result type is dropped');

    project.write('service/users.go', project.read('service/users.go').replace('(any, error)', '(*model.User, error)'));
    await syncAndCompare('the result type comes back');

    project.write('core/logger.go', project.read('core/logger.go').replace('func NewLogger() *Logger', 'func NewLogger() any'));
    await syncAndCompare('a constructor function loses its return type');
  });

  it('matches a fresh index when Dart receiver types or export chains change (T-515)', async () => {
    project.writeAll({
      'pubspec.yaml': 'name: app\n',
      'lib/core/logger.dart': "class Logger {\n  void info() {}\n  Logger child() => Logger();\n}\n",
      'lib/core/core.dart': "export 'logger.dart';\n",
      'lib/app.dart': "export 'core/core.dart';\n",
      'lib/bus.dart': "import 'core/logger.dart';\nclass Bus {\n  final Logger log = Logger();\n  Logger make() => Logger();\n}\n",
      'lib/main.dart':
        "import 'package:app/app.dart';\nimport 'bus.dart';\nvoid main(Logger given, Bus bus) {\n  final log = given.child();\n  log.info();\n  bus.log.info();\n  bus.make().info();\n}\n",
    });
    await fullIndex(project.root, dataDir);
    const initial = snapshotGraph(dataDir);
    // child, info (local), info (field), make, info (returned).
    expect(initial.edges.filter((e) => e.includes('"kind":"calls"'))).toHaveLength(5);

    project.write('lib/core/core.dart', '\n');
    await syncAndCompare('an export two levels down the chain disappears');

    project.write('lib/core/core.dart', "export 'logger.dart';\n");
    await syncAndCompare('the export comes back');

    project.write('lib/bus.dart', project.read('lib/bus.dart').replace('Logger make()', 'make()'));
    await syncAndCompare('a declared return type is dropped');

    project.write('lib/bus.dart', project.read('lib/bus.dart').replace('final Logger log', 'final log'));
    await syncAndCompare('a field falls back to its initializer');

    project.write('lib/core/logger.dart', project.read('lib/core/logger.dart').replace('void info()', 'void warn()'));
    await syncAndCompare('the target method is renamed');
  });

  it('matches a fresh index when Python receiver types change (T-515)', async () => {
    project.writeAll({
      'shop/__init__.py': '',
      'shop/logging.py': 'class Logger:\n    def info(self, m):\n        pass\n\n\nclass Audit:\n    def info(self, m):\n        pass\n',
      'shop/bus.py':
        'from shop.logging import Logger, Audit\n\n\nclass Bus:\n    def __init__(self):\n        self.log = Logger()\n\n\ndef make_bus():\n    return Bus()\n',
      'shop/hub.py': 'from shop.bus import Bus, make_bus\n',
      'shop/app.py':
        'from shop.hub import make_bus\n\n\ndef main():\n    bus = make_bus()\n    bus.log.info("x")\n',
    });
    await fullIndex(project.root, dataDir);
    const initial = snapshotGraph(dataDir);
    // make_bus, info (through the inferred return and the self field), Logger() and Bus().
    expect(initial.edges.filter((e) => e.includes('"kind":"calls"'))).toHaveLength(4);

    project.write('shop/bus.py', project.read('shop/bus.py').replace('self.log = Logger()', 'self.log = Audit()'));
    await syncAndCompare('a self field changes type in a file the caller does not import');

    project.write('shop/bus.py', project.read('shop/bus.py').replace('return Bus()', 'return None'));
    await syncAndCompare('the inferred return type goes away');

    project.write('shop/bus.py', project.read('shop/bus.py').replace('return None', 'return Bus()'));
    await syncAndCompare('the inferred return type comes back');

    project.write('shop/bus.py', project.read('shop/bus.py').replace('        self.log = Audit()\n', '        self.log = Audit()\n\n    def reset(self):\n        self.log = Logger()\n'));
    await syncAndCompare('a second method assigns the field another type');

    project.write('shop/logging.py', project.read('shop/logging.py').replace('def info', 'def warn'));
    await syncAndCompare('the target methods are renamed');
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

describe('sync parity with names declared in many files', () => {
  const COMMON: Record<string, string> = {
    ...Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `ts/w${i}.ts`,
        `export class W${i} {\n  run(): number {\n    return ${i};\n  }\n}\n\nexport function make${i}(): W${i} {\n  return new W${i}();\n}\n`,
      ]),
    ),
    ...Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [
        `ts/use${i}.ts`,
        `import { make${i} } from './w${i}';\n\nexport function use${i}(): number {\n  return make${i}().run();\n}\n`,
      ]),
    ),
    'ts/solo.ts': 'export function onlyHere(): number {\n  return 1;\n}\n',
    'ts/callsolo.ts': "import { onlyHere } from './solo';\n\nexport const v = onlyHere();\n",
    'py/a.py': 'class A:\n    def run(self):\n        return 1\n',
    'py/b.py': 'from a import A\n\n\ndef go():\n    return A().run()\n',
  };

  it('editing a body that moves a common method re-extracts only its real dependents, with parity', async () => {
    project.writeAll(COMMON);
    await fullIndex(project.root, dataDir);

    project.write('ts/w0.ts', `// moved down\n\n${COMMON['ts/w0.ts']}`);
    const read = vi.spyOn(fs.promises, 'readFile');
    expect(await syncProject({ root: project.root, dataDir })).toMatchObject({ modified: 1, truncated: false });
    const reads = new Set(read.mock.calls.map((c) => path.relative(project.root, String(c[0])).split(path.sep).join('/')));
    read.mockRestore();
    expect(snapshotGraph(dataDir)).toEqual(await fullIndexSnapshot(project.root));
    expect(reads.has('ts/w0.ts')).toBe(true);
    expect(reads.has('ts/use0.ts')).toBe(true);
    // The 29 other users of a same-named `run` are not touched.
    expect([...reads].filter((r) => /^ts\/use\d+\.ts$/.test(r)).length).toBeLessThan(5);

    project.write('ts/w1.ts', COMMON['ts/w1.ts']?.replace('run(): number', 'run(x = 1): number') ?? '');
    await syncAndCompare('change w1.run signature');
    project.write('ts/solo.ts', 'export function onlyHere(): number {\n  return 1;\n}\nexport function onlyHere2(): number {\n  return 2;\n}\n');
    await syncAndCompare('add a sibling');
    project.write('ts/w2.ts', `${COMMON['ts/w2.ts']}\nexport function onlyHere(): number {\n  return 3;\n}\n`);
    await syncAndCompare('a unique name becomes ambiguous');
    project.write('ts/w2.ts', `\n\n${COMMON['ts/w2.ts']}\nexport function onlyHere(): number {\n  return 3;\n}\n`);
    await syncAndCompare('the ambiguous duplicate moves');
    project.write('ts/w2.ts', COMMON['ts/w2.ts'] ?? '');
    await syncAndCompare('it becomes unique again');
    project.write('py/a.py', '\n\nclass A:\n    def run(self):\n        return 2\n');
    await syncAndCompare('python method moves');
    project.write('py/a.py', 'class A:\n    @staticmethod\n    def run():\n        return 2\n');
    await syncAndCompare('python method gains a decorator');
  }, 120_000);
});

