import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inferGoImplements } from './go-implements';
import { createHarness, type Harness } from './test-support';

let h: Harness;
beforeEach(() => {
  h = createHarness();
});
afterEach(() => h.close());

describe('inferGoImplements', () => {
  it('links a struct whose methods cover the interface, pointer receivers included', async () => {
    await h.addFiles({
      'io.go':
        'package p\n\ntype RW interface {\n\tRead()\n\tClose()\n}\n\ntype Writer interface {\n\tWrite()\n}\n\ntype Empty interface{}\n\ntype File struct{}\n\nfunc (f *File) Read() {}\n\nfunc (f File) Close() {}\n\ntype Half struct{}\n\nfunc (h Half) Read() {}\n',
    });
    expect(inferGoImplements(h.q).created).toBe(1);
    const edges = h.q.edgesFrom(h.sym('io.go', 'File').id, ['implements']);
    expect(edges.map((e) => e.target)).toEqual([h.sym('io.go', 'RW').id]);
    expect(h.targets(h.sym('io.go', 'Half').id, 'implements')).toEqual([]);
  });

  it('counts methods declared in another file of the package', async () => {
    await h.addFiles({
      'a.go':
        'package p\n\ntype S struct{}\n\ntype I interface {\n\tRun()\n}\n',
      'b.go': 'package p\n\nfunc (s *S) Run() {}\n',
    });
    expect(inferGoImplements(h.q).created).toBe(1);
  });

  it('is idempotent', async () => {
    await h.addFiles({
      'a.go':
        'package p\n\ntype S struct{}\n\nfunc (s S) Run() {}\n\ntype I interface {\n\tRun()\n}\n',
    });
    expect(inferGoImplements(h.q).created).toBe(1);
    expect(inferGoImplements(h.q).created).toBe(0);
  });

  it('skips an interface that would link to more than 50 structs', async () => {
    const src: string[] = [
      'package p\n\ntype Stringer interface {\n\tString()\n}\n',
    ];
    for (let i = 0; i < 51; i++)
      src.push(`type T${i} struct{}\n\nfunc (t T${i}) String() {}\n`);
    await h.addFiles({ 'a.go': src.join('\n') });
    expect(inferGoImplements(h.q)).toEqual({
      created: 0,
      skippedInterfaces: 1,
    });
    expect(h.q.edgesFrom(h.sym('a.go', 'T0').id, ['implements'])).toEqual([]);
  });

  it('ignores non-Go nodes', async () => {
    await h.addFiles({
      'A.java': 'class A { void run() {} }\ninterface I { void run(); }\n',
    });
    expect(inferGoImplements(h.q).created).toBe(0);
  });
});
