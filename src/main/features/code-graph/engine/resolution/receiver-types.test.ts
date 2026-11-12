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
  return h.targets(h.sym(file, qname).id, 'calls').sort();
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
