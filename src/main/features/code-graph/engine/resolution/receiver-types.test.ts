import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from './resolver';
import { createHarness, type Harness } from './test-support';

// Receiver type inference (S-44 T-515): a call on a receiver that is not `this`, `super` or an
// import binding reaches the method through the declared/initializer type of the receiver.

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

const LOGGER =
  'export class Logger {\n  info(m: string): void {}\n  child(s: string): Logger {\n    return new Logger();\n  }\n}\n';

function calls(file: string, qname: string): string[] {
  return [...new Set(h.targets(h.sym(file, qname).id, 'calls'))].sort();
}

describe('receiver type inference — TypeScript', () => {
  it('follows a field declared as a constructor parameter property', async () => {
    await h.addFiles({
      'src/logger.ts': LOGGER,
      'src/s.ts':
        "import { Logger } from './logger';\nexport class S {\n  constructor(private log: Logger) {}\n  run(): void {\n    this.log.info('x');\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/s.ts', 'S.run')).toEqual([h.sym('src/logger.ts', 'Logger.info').id]);
  });

  it('follows a field typed by its `new` initializer, generic arguments included', async () => {
    await h.addFiles({
      'src/repo.ts':
        'export class Repo<T> {\n  save(item: T): void {}\n}\n',
      'src/s.ts':
        "import { Repo } from './repo';\ninterface User { id: string }\nexport class S {\n  private repo = new Repo<User>();\n  f(u: User): void {\n    this.repo.save(u);\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/s.ts', 'S.f')).toEqual([h.sym('src/repo.ts', 'Repo.save').id]);
  });

  it('follows a local initialised with `new`, also from a nested callback', async () => {
    await h.addFiles({
      'src/logger.ts': LOGGER,
      'src/main.ts':
        "import { Logger } from './logger';\nexport function main(xs: string[]): void {\n  const log = new Logger();\n  log.child('b');\n  xs.forEach((x) => log.info(x));\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/main.ts', 'main')).toEqual(
      [h.sym('src/logger.ts', 'Logger.child').id, h.sym('src/logger.ts', 'Logger.info').id].sort(),
    );
  });

  it('follows a typed parameter, through a re-exporting index and a type-only import', async () => {
    await h.addFiles({
      'src/services/user-service.ts':
        'export class UserService {\n  register(): string {\n    return "";\n  }\n}\n',
      'src/services/index.ts': "export { UserService } from './user-service';\n",
      'src/h.ts':
        "import type { UserService } from './services';\nexport function h(users: UserService): void {\n  users.register();\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/h.ts', 'h')).toEqual([
      h.sym('src/services/user-service.ts', 'UserService.register').id,
    ]);
  });

  it('substitutes a generic return type: `repo.get(): T` with `repo: InMemoryRepository<Order>`', async () => {
    await h.addFiles({
      'src/order.ts': 'export class Order {\n  markPaid(): void {}\n  total(): number {\n    return 1;\n  }\n}\n',
      'src/repository.ts':
        'export class InMemoryRepository<T extends { id: string }> {\n  get(id: string): T {\n    throw new Error(id);\n  }\n}\n',
      'src/order-service.ts':
        "import { Order } from './order';\nimport { InMemoryRepository } from './repository';\nexport class OrderService {\n  private readonly repo = new InMemoryRepository<Order>();\n  pay(id: string): number {\n    const order = this.repo.get(id);\n    order.markPaid();\n    return order.total();\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/order-service.ts', 'OrderService.pay')).toEqual(
      [
        h.sym('src/repository.ts', 'InMemoryRepository.get').id,
        h.sym('src/order.ts', 'Order.markPaid').id,
        h.sym('src/order.ts', 'Order.total').id,
      ].sort(),
    );
  });

  it('follows chains: field of a typed field, a call result used directly, a declared return type', async () => {
    await h.addFiles({
      'src/logger.ts': LOGGER,
      'src/bus.ts':
        "import { Logger } from './logger';\nexport class Bus {\n  readonly log: Logger = new Logger();\n  logger(): Logger {\n    return this.log;\n  }\n}\n",
      'src/app.ts':
        "import { Bus } from './bus';\nexport class App {\n  constructor(private readonly bus: Bus) {}\n  run(): void {\n    this.bus.log.info('a');\n    this.bus.logger().child('c');\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/app.ts', 'App.run')).toEqual(
      [
        h.sym('src/bus.ts', 'Bus.logger').id,
        h.sym('src/logger.ts', 'Logger.child').id,
        h.sym('src/logger.ts', 'Logger.info').id,
      ].sort(),
    );
  });

  it('targets the interface method when the receiver is declared with the interface type', async () => {
    await h.addFiles({
      'src/repo.ts':
        'export interface Repository<T> {\n  get(id: string): T;\n}\nexport class Impl<T> implements Repository<T> {\n  get(id: string): T {\n    throw new Error(id);\n  }\n}\n',
      'src/s.ts':
        "import { Repository } from './repo';\nexport function f(r: Repository<string>): void {\n  r.get('1');\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/s.ts', 'f')).toEqual([h.sym('src/repo.ts', 'Repository.get', 'method').id]);
  });

  it('stays silent on an untyped receiver instead of guessing by method name', async () => {
    await h.addFiles({
      'src/logger.ts': LOGGER,
      'src/s.ts':
        "import { Logger } from './logger';\nexport function info(): void {}\nexport function f(log, other: Logger): void {\n  log.info('x');\n  const info = (other as unknown) as { go(): void };\n  info.go();\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/s.ts', 'f')).toEqual([]);
  });

  it('a local shadows a module-level symbol of the same name', async () => {
    await h.addFiles({
      'src/s.ts':
        "export const log = { info(): void {} };\nexport function f(): void {\n  const log = make();\n  log.info();\n}\nfunction make(): unknown {\n  return 1;\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('src/s.ts', 'f')).toEqual([h.sym('src/s.ts', 'make').id]);
  });

  it('re-resolving only the caller still sees the bindings of an untouched file that declares the type', async () => {
    await h.addFiles({
      'src/user.ts': 'export class User {\n  hello(): void {}\n}\n',
      'src/user-service.ts':
        "import { User } from './user';\nexport class UserService {\n  find(): User {\n    return new User();\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    await h.addFiles({
      'src/app.ts':
        "import { UserService } from './user-service';\nexport function app(s: UserService): void {\n  s.find().hello();\n}\n",
    });
    resolveReferences(h.q, h.root, ['src/app.ts']);
    expect(calls('src/app.ts', 'app')).toEqual(
      [h.sym('src/user-service.ts', 'UserService.find').id, h.sym('src/user.ts', 'User.hello').id].sort(),
    );
  });
});

describe('receiver type inference — Java', () => {
  const J = 'src/main/java/com/acme';
  const JLOGGER =
    'package com.acme.core;\npublic class Logger {\n  public Logger(String s) {}\n  public void info(String m) {}\n  public Logger child(String s) {\n    return new Logger(s);\n  }\n}\n';
  const IDENTIFIED = 'package com.acme.model;\npublic interface Identified {\n  String getId();\n}\n';
  const ENTITY =
    'package com.acme.model;\npublic abstract class Entity implements Identified {\n  @Override\n  public String getId() {\n    return "";\n  }\n}\n';
  const ORDER =
    'package com.acme.model;\nimport java.util.List;\npublic class Order extends Entity {\n  public static class Line {\n    public long total() {\n      return 1;\n    }\n  }\n  private List<Line> lines;\n  public void markPaid() {}\n  public long total() {\n    long sum = 0;\n    for (Line l : lines) {\n      sum += l.total();\n    }\n    return sum;\n  }\n}\n';
  const REPOSITORY =
    'package com.acme.service;\nimport com.acme.model.Identified;\npublic interface Repository<T extends Identified> {\n  T get(String id);\n  void save(T item);\n}\n';
  const IN_MEMORY =
    'package com.acme.service;\nimport com.acme.model.Identified;\npublic class InMemoryRepository<T extends Identified> implements Repository<T> {\n  @Override\n  public T get(String id) {\n    return null;\n  }\n  @Override\n  public void save(T item) {\n    System.out.println(item.getId());\n  }\n}\n';

  function jcalls(file: string, qname: string): string[] {
    return calls(`${J}/${file}`, qname);
  }
  function jsym(file: string, qname: string): string {
    return h.sym(`${J}/${file}`, qname, 'method').id;
  }

  it('follows a local built with `new`, a typed parameter and a captured local inside a lambda', async () => {
    await h.addFiles({
      [`${J}/core/Logger.java`]: JLOGGER,
      [`${J}/App.java`]:
        'package com.acme;\nimport com.acme.core.Logger;\nimport java.util.List;\npublic class App {\n  void main(List<String> xs, Logger given) {\n    Logger log = new Logger("a");\n    log.child("b");\n    var other = log.child("c");\n    other.info("x");\n    xs.forEach(x -> given.info(x));\n  }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(jcalls('App.java', 'App.main')).toEqual(
      [jsym('core/Logger.java', 'Logger.child'), jsym('core/Logger.java', 'Logger.info')].sort(),
    );
  });

  it('follows a field declared with an interface type to the interface method, not the impl', async () => {
    await h.addFiles({
      [`${J}/model/Identified.java`]: IDENTIFIED,
      [`${J}/model/Entity.java`]: ENTITY,
      [`${J}/model/User.java`]: 'package com.acme.model;\npublic class User extends Entity {\n  public String getName() {\n    return "";\n  }\n}\n',
      [`${J}/service/Repository.java`]: REPOSITORY,
      [`${J}/service/InMemoryRepository.java`]: IN_MEMORY,
      [`${J}/service/UserService.java`]:
        'package com.acme.service;\nimport com.acme.model.User;\npublic class UserService {\n  private final Repository<User> repo = new InMemoryRepository<>();\n  public User find(String id) {\n    return repo.get(id);\n  }\n  public String name(String id) {\n    this.repo.save(null);\n    return find(id).getName() + repo.get(id).getId();\n  }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(jcalls('service/UserService.java', 'UserService.find')).toEqual([jsym('service/Repository.java', 'Repository.get')]);
    expect(jcalls('service/UserService.java', 'UserService.name')).toEqual(
      [
        jsym('service/Repository.java', 'Repository.save'),
        jsym('service/Repository.java', 'Repository.get'),
        jsym('service/UserService.java', 'UserService.find'),
        jsym('model/User.java', 'User.getName'),
        jsym('model/Entity.java', 'Entity.getId'),
      ].sort(),
    );
  });

  it('follows an enhanced-for variable, a catch parameter and a bounded type parameter', async () => {
    await h.addFiles({
      [`${J}/model/Identified.java`]: IDENTIFIED,
      [`${J}/model/Entity.java`]: ENTITY,
      [`${J}/model/Order.java`]: ORDER,
      [`${J}/service/Repository.java`]: REPOSITORY,
      [`${J}/service/InMemoryRepository.java`]: IN_MEMORY,
      [`${J}/core/DomainException.java`]:
        'package com.acme.core;\npublic class DomainException extends RuntimeException {\n  public String getCode() {\n    return "";\n  }\n}\n',
      [`${J}/api/Router.java`]:
        'package com.acme.api;\nimport com.acme.core.DomainException;\npublic class Router {\n  public String dispatch() {\n    try {\n      return "";\n    } catch (DomainException e) {\n      return e.getCode();\n    }\n  }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(jcalls('model/Order.java', 'Order.total')).toEqual([jsym('model/Order.java', 'Order.Line.total')]);
    expect(jcalls('api/Router.java', 'Router.dispatch')).toEqual([jsym('core/DomainException.java', 'DomainException.getCode')]);
    expect(jcalls('service/InMemoryRepository.java', 'InMemoryRepository.save')).toEqual([
      jsym('model/Identified.java', 'Identified.getId'),
    ]);
  });

  it('substitutes generic arguments through a field and a chained call', async () => {
    await h.addFiles({
      [`${J}/model/Identified.java`]: IDENTIFIED,
      [`${J}/model/Entity.java`]: ENTITY,
      [`${J}/model/Order.java`]: ORDER,
      [`${J}/service/Repository.java`]: REPOSITORY,
      [`${J}/service/InMemoryRepository.java`]: IN_MEMORY,
      [`${J}/service/OrderService.java`]:
        'package com.acme.service;\nimport com.acme.model.Order;\npublic class OrderService {\n  private final InMemoryRepository<Order> repo = new InMemoryRepository<>();\n  public long pay(String id) {\n    Order order = this.repo.get(id);\n    order.markPaid();\n    return repo.get(id).total();\n  }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(jcalls('service/OrderService.java', 'OrderService.pay')).toEqual(
      [
        jsym('service/InMemoryRepository.java', 'InMemoryRepository.get'),
        jsym('model/Order.java', 'Order.markPaid'),
        jsym('model/Order.java', 'Order.total'),
      ].sort(),
    );
  });

  it('tells a field from a method of the same name (`events` vs `events()`)', async () => {
    await h.addFiles({
      [`${J}/core/Bus.java`]: 'package com.acme.core;\npublic class Bus<T> {\n  public void publish(T e) {}\n  public void subscribe() {}\n}\n',
      [`${J}/core/Service.java`]:
        'package com.acme.core;\npublic class Service {\n  private final Bus<String> events = new Bus<>();\n  public Bus<String> events() {\n    return events;\n  }\n  void open() {\n    events.publish("x");\n  }\n}\n',
      [`${J}/App.java`]:
        'package com.acme;\nimport com.acme.core.Service;\npublic class App {\n  void main(Service s) {\n    s.events().subscribe();\n  }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(jcalls('core/Service.java', 'Service.open')).toEqual([jsym('core/Bus.java', 'Bus.publish')]);
    expect(jcalls('App.java', 'App.main')).toEqual(
      [jsym('core/Service.java', 'Service.events'), jsym('core/Bus.java', 'Bus.subscribe')].sort(),
    );
  });

  it('stays silent on untyped lambda parameters and unknown computed receivers', async () => {
    await h.addFiles({
      [`${J}/core/Logger.java`]: JLOGGER,
      [`${J}/App.java`]:
        'package com.acme;\nimport com.acme.core.Logger;\nimport java.util.List;\npublic class App {\n  private Logger log;\n  void info(String s) {}\n  void run(List<Logger> xs, String[] args) {\n    xs.forEach(log -> log.info("x"));\n    args[0].info();\n    String.valueOf(1).info();\n  }\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(jcalls('App.java', 'App.run')).toEqual([]);
  });
});

describe('receiver type inference — Go', () => {
  const MOD = 'module example.com/m\n\ngo 1.22\n';
  const CORE =
    'package core\n\ntype Logger struct{ scope string }\n\nfunc NewLogger(s string) *Logger {\n\treturn &Logger{scope: s}\n}\n\nfunc (l *Logger) Info(m string) {}\n\nfunc (l *Logger) Child(s string) *Logger {\n\treturn NewLogger(s)\n}\n';
  const MODEL =
    'package model\n\ntype Identified interface {\n\tID() string\n}\n\ntype base struct{ id string }\n\nfunc (b base) ID() string {\n\treturn b.id\n}\n\ntype User struct {\n\tbase\n\tName string\n}\n\ntype Order struct {\n\tbase\n}\n\nfunc (o *Order) MarkPaid() {}\n';
  const STORE =
    'package store\n\nimport "example.com/m/model"\n\ntype Store interface {\n\tGet(id string) (model.Identified, error)\n\tSave(item model.Identified)\n}\n\ntype Memory struct{}\n\nfunc (m *Memory) Get(id string) (model.Identified, error) {\n\treturn nil, nil\n}\n\nfunc (m *Memory) Save(item model.Identified) {\n\t_ = item.ID()\n}\n';

  function gfn(file: string, qname: string): string[] {
    return calls(file, qname);
  }

  it('follows a local typed by a function\'s declared return type, chained and captured', async () => {
    await h.addFiles({
      'go.mod': MOD,
      'core/logger.go': CORE,
      'main.go':
        'package main\n\nimport "example.com/m/core"\n\nfunc run(xs []string) {\n\tlog := core.NewLogger("s")\n\tlog.Child("a").Info("x")\n\tfor _, x := range xs {\n\t\tfunc() { log.Info(x) }()\n\t}\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(gfn('main.go', 'run')).toEqual(
      [h.sym('core/logger.go', 'NewLogger').id, h.sym('core/logger.go', 'Logger.Child').id, h.sym('core/logger.go', 'Logger.Info').id].sort(),
    );
  });

  it('follows struct field types to the interface method, an interface parameter, and the first of several results', async () => {
    await h.addFiles({
      'go.mod': MOD,
      'model/model.go': MODEL,
      'store/store.go': STORE,
      'service/users.go':
        'package service\n\nimport (\n\t"example.com/m/model"\n\t"example.com/m/store"\n)\n\ntype Users struct {\n\tstore store.Store\n}\n\nfunc (s *Users) Register(u *model.User) string {\n\ts.store.Save(u)\n\titem, err := s.store.Get("1")\n\t_ = err\n\treturn item.ID() + u.ID()\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(gfn('service/users.go', 'Users.Register')).toEqual(
      [
        h.sym('store/store.go', 'Store.Save', 'method').id,
        h.sym('store/store.go', 'Store.Get', 'method').id,
        h.sym('model/model.go', 'Identified.ID', 'method').id,
        h.sym('model/model.go', 'base.ID', 'method').id,
      ].sort(),
    );
    expect(gfn('store/store.go', 'Memory.Save')).toEqual([h.sym('model/model.go', 'Identified.ID', 'method').id]);
  });

  it('follows type assertions and type switch aliases', async () => {
    await h.addFiles({
      'go.mod': MOD,
      'model/model.go': MODEL,
      'service/orders.go':
        'package service\n\nimport "example.com/m/model"\n\nfunc Pay(item model.Identified) {\n\torder := item.(*model.Order)\n\torder.MarkPaid()\n\tswitch v := item.(type) {\n\tcase *model.User:\n\t\t_ = v.Name\n\t\tv.ID()\n\tcase *model.Order:\n\t\tv.MarkPaid()\n\t}\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(gfn('service/orders.go', 'Pay')).toEqual(
      [h.sym('model/model.go', 'Order.MarkPaid', 'method').id, h.sym('model/model.go', 'base.ID', 'method').id].sort(),
    );
  });

  it('a parameter shadows an imported package of the same name; untyped values stay silent', async () => {
    await h.addFiles({
      'go.mod': MOD,
      'model/model.go': MODEL,
      'store/store.go': STORE + '\nfunc NewMemory() *Memory {\n\treturn &Memory{}\n}\n',
      'main.go':
        'package main\n\nimport "example.com/m/store"\n\nfunc run(store store.Store, m map[string]*store.Memory, fs []func()) {\n\tstore.Save(nil)\n\tv, ok := m["a"]\n\t_ = ok\n\tv.Save(nil)\n\tfor _, f := range fs {\n\t\tf()\n\t}\n}\n',
    });
    resolveReferences(h.q, h.root);
    expect(gfn('main.go', 'run')).toEqual([h.sym('store/store.go', 'Store.Save', 'method').id]);
  });
});

describe('receiver type inference — Dart', () => {
  const PUB = 'name: app\n';
  const DLOGGER =
    "class Logger {\n  Logger(this.scope);\n  Logger.root() : scope = '';\n  final String scope;\n  void info(String m) {}\n  Logger child(String s) => Logger(s);\n}\n";
  const ENTITY = 'abstract class Entity {\n  String get id;\n  String describe() => id;\n}\n';
  const ORDER =
    "import 'entity.dart';\nclass Order extends Entity {\n  @override\n  String get id => '';\n  void markPaid() {}\n}\n";
  const REPO =
    "import 'package:app/models/entity.dart';\nclass InMemoryRepository<T extends Entity> {\n  T get(String id) => throw 1;\n  void save(T item) {\n    item.describe();\n  }\n}\n";

  it('follows `final x = Foo()`, a named constructor, a typed parameter and a captured local', async () => {
    await h.addFiles({
      'pubspec.yaml': PUB,
      'lib/core/logger.dart': DLOGGER,
      'lib/app.dart': "export 'core/logger.dart';\n",
      'lib/main.dart':
        "import 'package:app/app.dart';\nvoid main(List<String> xs, Logger given) {\n  final log = Logger('a');\n  log.child('b');\n  Logger.root().info('r');\n  xs.forEach((x) => given.info(x));\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('lib/main.dart', 'main')).toEqual(
      [h.sym('lib/core/logger.dart', 'Logger.child').id, h.sym('lib/core/logger.dart', 'Logger.info').id].sort(),
    );
  });

  it('follows fields, generic substitution, a bounded type parameter, for-in and `on T catch (e)`', async () => {
    await h.addFiles({
      'pubspec.yaml': PUB,
      'lib/models/entity.dart': ENTITY,
      'lib/models/order.dart': ORDER,
      'lib/errors.dart': 'class DomainException implements Exception {\n  String code() => "";\n}\n',
      'lib/services/repository.dart': REPO,
      'lib/services/order_service.dart':
        "import 'package:app/models/order.dart';\nimport '../errors.dart';\nimport 'repository.dart';\nclass OrderService {\n  final InMemoryRepository<Order> _repo = InMemoryRepository<Order>();\n  void pay(String id, List<Order> all) {\n    final order = _repo.get(id);\n    order.markPaid();\n    this._repo.get(id).markPaid();\n    for (Order o in all) {\n      o.describe();\n    }\n    try {} on DomainException catch (e) {\n      e.code();\n    }\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('lib/services/order_service.dart', 'OrderService.pay')).toEqual(
      [
        h.sym('lib/services/repository.dart', 'InMemoryRepository.get').id,
        h.sym('lib/models/order.dart', 'Order.markPaid').id,
        h.sym('lib/models/entity.dart', 'Entity.describe').id,
        h.sym('lib/errors.dart', 'DomainException.code').id,
      ].sort(),
    );
    expect(calls('lib/services/repository.dart', 'InMemoryRepository.save')).toEqual([
      h.sym('lib/models/entity.dart', 'Entity.describe').id,
    ]);
  });

  it('stays silent on a type the library does not import and on untyped closure parameters', async () => {
    await h.addFiles({
      'pubspec.yaml': PUB,
      'lib/core/logger.dart': DLOGGER,
      'lib/main.dart':
        "import 'package:logging/logging.dart';\nvoid main(List<Logger> xs, Logger log) {\n  log.info('x');\n  xs.forEach((l) => l.child('y'));\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('lib/main.dart', 'main')).toEqual([]);
  });

  it('types the receiver of a cascade instead of matching the bare method name', async () => {
    await h.addFiles({
      'pubspec.yaml': PUB,
      'lib/core/logger.dart': DLOGGER,
      'lib/main.dart':
        "import 'core/logger.dart';\nclass App {\n  void info(String m) {}\n  void run() {\n    Logger('a')\n      ..info('x');\n  }\n}\n",
    });
    resolveReferences(h.q, h.root);
    expect(calls('lib/main.dart', 'App.run')).toEqual([h.sym('lib/core/logger.dart', 'Logger.info').id]);
  });
});
