import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { typescriptResolver } from './import-resolver';
import {
  registerLanguageResolver,
  resolverFor,
  type ResolveContext,
} from './language-resolvers';
import { parseJsonc } from './path-aliases';

let root: string;

function write(rel: string, content = ''): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

function ctxOf(files: string[]): ResolveContext {
  const set = new Set(files);
  return { root, fileExists: (rel) => set.has(rel), listFiles: () => [...set] };
}

function resolve(
  from: string,
  spec: string,
  files: string[],
): string | undefined {
  return typescriptResolver.resolveImport(from, spec, ctxOf(files));
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-imp-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('parseJsonc', () => {
  it('accepts comments and trailing commas without touching strings', () => {
    const text = `\uFEFF{
      // line comment
      "a": "http://x.y/*not a comment*/", /* block */
      "b": [1, 2,],
      "c": { "d": ",}", },
    }`;
    expect(parseJsonc(text)).toEqual({
      a: 'http://x.y/*not a comment*/',
      b: [1, 2],
      c: { d: ',}' },
    });
  });

  it('returns undefined for garbage', () => {
    expect(parseJsonc('{ nope')).toBeUndefined();
  });
});

describe('typescriptResolver relative specifiers', () => {
  it('tries the TS and JS extensions, then index files', () => {
    expect(resolve('src/a.ts', './b', ['src/a.ts', 'src/b.ts'])).toBe(
      'src/b.ts',
    );
    expect(resolve('src/a.ts', './b', ['src/a.ts', 'src/b.tsx'])).toBe(
      'src/b.tsx',
    );
    expect(resolve('src/a.ts', './b', ['src/a.ts', 'src/b.d.ts'])).toBe(
      'src/b.d.ts',
    );
    expect(resolve('src/a.ts', './b', ['src/a.ts', 'src/b.js'])).toBe(
      'src/b.js',
    );
    expect(resolve('src/a.ts', './lib', ['src/lib/index.ts'])).toBe(
      'src/lib/index.ts',
    );
    expect(resolve('src/x/a.ts', '../lib', ['src/lib/index.jsx'])).toBe(
      'src/lib/index.jsx',
    );
    expect(resolve('src/a.ts', './b.ts', ['src/b.ts'])).toBe('src/b.ts');
  });

  it('prefers a .ts file over a directory index', () => {
    expect(resolve('src/a.ts', './b', ['src/b.ts', 'src/b/index.ts'])).toBe(
      'src/b.ts',
    );
  });

  it('maps ESM-style .js specifiers to the TS sources', () => {
    expect(resolve('src/a.ts', './b.js', ['src/b.ts'])).toBe('src/b.ts');
    expect(resolve('src/a.ts', './c.js', ['src/c.tsx'])).toBe('src/c.tsx');
    expect(resolve('src/a.ts', './d.mjs', ['src/d.mts'])).toBe('src/d.mts');
    expect(resolve('src/a.ts', './e.js', ['src/e.js'])).toBe('src/e.js');
  });

  it('never escapes the project root', () => {
    expect(resolve('a.ts', '../outside', ['a.ts'])).toBeUndefined();
  });

  it('leaves bare and scoped packages unresolved', () => {
    expect(
      resolve('src/a.ts', 'react', ['src/a.ts', 'react.ts']),
    ).toBeUndefined();
    expect(resolve('src/a.ts', '@scope/x', ['src/a.ts'])).toBeUndefined();
    expect(resolve('src/a.ts', 'node:fs', ['src/a.ts'])).toBeUndefined();
  });
});

describe('typescriptResolver tsconfig paths', () => {
  it('resolves paths relative to baseUrl', () => {
    write(
      'tsconfig.json',
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/app/*"] } } }',
    );
    expect(resolve('src/main.ts', '@app/util', ['src/app/util.ts'])).toBe(
      'src/app/util.ts',
    );
    expect(
      resolve('src/main.ts', '@app/util/deep', ['src/app/util/deep/index.ts']),
    ).toBe('src/app/util/deep/index.ts');
  });

  it('resolves paths relative to the config when there is no baseUrl, with JSONC', () => {
    write(
      'web/tsconfig.json',
      `{
        // comment
        "compilerOptions": { "paths": { "~/*": ["./src/*",], }, },
      }`,
    );
    expect(resolve('web/src/a.ts', '~/b', ['web/src/b.ts'])).toBe(
      'web/src/b.ts',
    );
  });

  it('supports exact aliases and picks the longest matching prefix', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: {
            '@cfg': ['src/config.ts'],
            '@/*': ['src/*'],
            '@/ui/*': ['src/ui-kit/*'],
          },
        },
      }),
    );
    const files = ['src/config.ts', 'src/ui/button.ts', 'src/ui-kit/button.ts'];
    expect(resolve('src/a.ts', '@cfg', files)).toBe('src/config.ts');
    expect(resolve('src/a.ts', '@/ui/button', files)).toBe(
      'src/ui-kit/button.ts',
    );
  });

  it('tries each target of a pattern in order', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '#/*': ['gen/*', 'src/*'] } },
      }),
    );
    expect(resolve('src/a.ts', '#/b', ['src/b.ts'])).toBe('src/b.ts');
  });

  it('falls back to baseUrl for non-relative specifiers', () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { baseUrl: 'src' } }),
    );
    expect(resolve('src/a.ts', 'utils/x', ['src/utils/x.ts'])).toBe(
      'src/utils/x.ts',
    );
    expect(resolve('src/a.ts', 'react', ['src/utils/x.ts'])).toBeUndefined();
  });

  it('inherits paths through relative extends, resolved from the defining config', () => {
    write(
      'config/base.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '..', paths: { '@lib/*': ['lib/*'] } },
      }),
    );
    write(
      'app/tsconfig.json',
      JSON.stringify({
        extends: '../config/base',
        compilerOptions: { strict: true },
      }),
    );
    expect(resolve('app/main.ts', '@lib/x', ['lib/x.ts'])).toBe('lib/x.ts');
  });

  it('lets the child override inherited paths and ignores package extends', () => {
    write(
      'tsconfig.base.json',
      JSON.stringify({ compilerOptions: { paths: { '@x/*': ['./old/*'] } } }),
    );
    write(
      'tsconfig.json',
      JSON.stringify({
        extends: ['@tsconfig/node20/tsconfig.json', './tsconfig.base.json'],
        compilerOptions: { paths: { '@x/*': ['./new/*'] } },
      }),
    );
    expect(resolve('a.ts', '@x/y', ['old/y.ts', 'new/y.ts'])).toBe('new/y.ts');
  });

  it('survives an extends cycle', () => {
    write(
      'a.json',
      JSON.stringify({
        extends: './b.json',
        compilerOptions: { paths: { '@a/*': ['./a/*'] } },
      }),
    );
    write('b.json', JSON.stringify({ extends: './a.json' }));
    write('tsconfig.json', JSON.stringify({ extends: './a.json' }));
    expect(resolve('x.ts', '@a/q', ['a/q.ts'])).toBe('a/q.ts');
  });

  it('uses the nearest config per directory', () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./root/*'] } } }),
    );
    write(
      'packages/web/tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    const files = ['root/u.ts', 'packages/web/src/u.ts'];
    expect(resolve('packages/web/src/deep/a.ts', '@/u', files)).toBe(
      'packages/web/src/u.ts',
    );
    expect(resolve('other/a.ts', '@/u', files)).toBe('root/u.ts');
  });

  it('reads jsconfig.json too', () => {
    write(
      'jsconfig.json',
      JSON.stringify({
        compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } },
      }),
    );
    expect(resolve('src/a.js', '@/b', ['src/b.js'])).toBe('src/b.js');
  });

  it('follows solution-style references when the root config has no paths', () => {
    write(
      'tsconfig.json',
      JSON.stringify({
        files: [],
        references: [{ path: './tsconfig.app.json' }],
      }),
    );
    write(
      'tsconfig.app.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./src/*'] } } }),
    );
    expect(resolve('src/a.ts', '@/b', ['src/b.ts'])).toBe('src/b.ts');
  });

  it('ignores a broken config and aliases pointing outside the root', () => {
    write('tsconfig.json', '{ broken');
    expect(resolve('src/a.ts', './b', ['src/b.ts'])).toBe('src/b.ts');
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@up/*': ['../*'] } } }),
    );
    expect(resolve('src/a.ts', '@up/b', ['src/b.ts'])).toBeUndefined();
  });

  it('does not cache configs across contexts', () => {
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./a/*'] } } }),
    );
    expect(resolve('x.ts', '@/m', ['a/m.ts', 'b/m.ts'])).toBe('a/m.ts');
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@/*': ['./b/*'] } } }),
    );
    expect(resolve('x.ts', '@/m', ['a/m.ts', 'b/m.ts'])).toBe('b/m.ts');
  });
});

describe('language resolver registry', () => {
  it('registers TypeScript and JavaScript resolvers and accepts new ones', () => {
    expect(resolverFor('typescript')).toBe(typescriptResolver);
    expect(resolverFor('javascript')?.language).toBe('javascript');
    const previous = resolverFor('go');
    try {
      registerLanguageResolver({ language: 'go', resolveImport: () => 'x.go' });
      expect(resolverFor('go')?.resolveImport('a.go', 'x', ctxOf([]))).toBe(
        'x.go',
      );
    } finally {
      if (previous) registerLanguageResolver(previous);
      else
        registerLanguageResolver({
          language: 'go',
          resolveImport: () => undefined,
        });
    }
  });
});
