import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveReferences } from '../resolution/resolver';
import { createHarness, type Harness } from '../resolution/test-support';
import { getNodeDetail } from './node-detail';
import { mkNode, openTempDb, seedGraph } from './test-graph';

const FILES: Record<string, string> = {
  'src/r1.ts': `export class Runner {
  /** Runs the runner. */
  run(): string {
    return helper();
  }
  stop(): void {}
}
function helper(): string {
  return 'r';
}
`,
  'src/r2.ts': `export class Task {
  run(): string {
    return 'task';
  }
}
`,
  'src/use.ts': `import { Task } from './r2';
export function caller1(t: Task): string {
  return t.run();
}
`,
};

let h: Harness;

beforeEach(async () => {
  h = createHarness();
  await h.addFiles(FILES);
  resolveReferences(h.q, h.root);
});

afterEach(() => h.close());

describe('getNodeDetail', () => {
  it('returns every overload with full body in one result', () => {
    const d = getNodeDetail(h.q, h.root, 'run');
    expect(d.found).toBe(true);
    expect(d.matches).toHaveLength(2);
    const bodies = d.matches.map((m) => m.body).join('\n');
    expect(bodies).toContain('return helper();');
    expect(bodies).toContain("return 'task'");
    const runner = d.matches.find((m) => m.node.filePath === 'src/r1.ts');
    expect(runner?.signature).toBeDefined();
    expect(runner?.docstring).toContain('Runs the runner');
    expect(runner?.location).toMatch(/^src\/r1\.ts:\d+$/);
    expect(runner?.callees.map((c) => c.node.name)).toContain('helper');
    expect(d.markdown).toContain('src/r1.ts');
    expect(d.markdown).toContain('src/r2.ts');
  });

  it('accepts ids and lists class members', () => {
    const cls = h.sym('src/r1.ts', 'Runner', 'class');
    const d = getNodeDetail(h.q, h.root, cls.id);
    expect(d.matches).toHaveLength(1);
    expect(d.matches[0]?.isExported).toBe(true);
    expect(d.matches[0]?.members.map((m) => m.name).sort()).toEqual([
      'run',
      'stop',
    ]);
  });

  it('caps the trail at 10 callers and callees', async () => {
    const files: Record<string, string> = {
      'src/hub.ts': `export function hub() {}\n`,
    };
    let body = '';
    for (let i = 0; i < 15; i++) {
      files[`src/c${i}.ts`] = `import { hub } from './hub';\nexport function c${i}() { hub(); }\n`;
      files[`src/d${i}.ts`] = `export function d${i}() {}\n`;
      body += `  d${i}();\n`;
    }
    files['src/hub.ts'] =
      Object.keys(files)
        .filter((f) => f.includes('/d'))
        .map((f, i) => `import { d${i} } from './d${i}';`)
        .join('\n') + `\nexport function hub() {\n${body}}\n`;
    await h.addFiles(files);
    resolveReferences(h.q, h.root);
    const d = getNodeDetail(h.q, h.root, 'hub');
    expect(d.matches[0]?.callers).toHaveLength(10);
    expect(d.matches[0]?.callees).toHaveLength(10);
  });

  it('never throws for an unknown name', () => {
    const d = getNodeDetail(h.q, h.root, 'doesNotExist');
    expect(d.found).toBe(false);
    expect(d.matches).toEqual([]);
    expect(d.markdown).toContain('doesNotExist');
    expect(d.markdown).toMatch(/graph_explore|graph_search/);
    expect(d.markdown).not.toMatch(/use Read|\bgrep\b/i);
    expect(getNodeDetail(h.q, h.root, '  ').found).toBe(false);
  });

  it('notes a file deleted after indexing', () => {
    fs.rmSync(path.join(h.root, 'src/r2.ts'));
    const d = getNodeDetail(h.q, h.root, 'Task.run');
    expect(d.found).toBe(true);
    expect(d.matches[0]?.note).toContain('run graph_status');
    expect(d.matches[0]?.body).toBe('');
  });

  it('expands at most 8 overloads and lists the rest', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++)
      files[`src/o${i}.ts`] = `export class O${i} {\n  go(): number {\n    return ${i};\n  }\n}\n`;
    await h.addFiles(files);
    const d = getNodeDetail(h.q, h.root, 'go');
    expect(d.matches).toHaveLength(8);
    expect(d.omitted).toHaveLength(2);
    expect(d.omitted[0]?.location).toMatch(/^src\/o\d\.ts:2$/);
    expect(d.markdown).toContain('2 more matches not expanded');
  });

  it('fences bodies containing triple backticks', async () => {
    await h.addFiles({
      'src/md.ts': 'export function md(): string {\n  return "```";\n}\n',
    });
    const d = getNodeDetail(h.q, h.root, 'md');
    expect(d.markdown).toContain('````\nexport function md');
  });

  it('notes an escaping indexed path instead of throwing', () => {
    const t = openTempDb();
    try {
      seedGraph(t.q, [mkNode('evil', { filePath: '../../etc/passwd' })], []);
      const d = getNodeDetail(t.q, h.root, 'evil');
      expect(d.matches[0]?.note).toBe('path outside the project root — skipped');
    } finally {
      t.close();
    }
  });
});
