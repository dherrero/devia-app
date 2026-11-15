import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';
import { javascriptResolver, typescriptResolver } from './import-resolver';
import { dartResolver } from './languages/dart';
import { goResolver } from './languages/go';
import { javaResolver } from './languages/java';
import { pythonResolver } from './languages/python';

export interface ResolveContext {
  root: string;
  fileExists(rel: string): boolean;
  listFiles(): string[];
  /** Text of a non-indexed project file (`go.mod`, `pubspec.yaml`), or undefined when absent. */
  readText?(rel: string): string | undefined;
}

export interface LanguageResolver {
  language: CodeGraphLanguage;
  /** Root-relative path of an indexed file, or undefined (external package, missing file). */
  resolveImport(
    fromFile: string,
    spec: string,
    ctx: ResolveContext,
  ): string | undefined;
  /**
   * Every file an import brings in (Java `pkg.*`, a Go package). The first one stands for the
   * import in the single-file contract; the core links all of them.
   */
  resolveImportAll?(
    fromFile: string,
    spec: string,
    ctx: ResolveContext,
    star: boolean,
  ): string[];
  /** `from pkg import name` where `name` is itself a module: its file, tried before symbols. */
  resolveSubmodule?(
    fromFile: string,
    spec: string,
    imported: string,
    ctx: ResolveContext,
  ): string | undefined;
}

const resolvers = new Map<CodeGraphLanguage, LanguageResolver>();

export function registerLanguageResolver(r: LanguageResolver): void {
  resolvers.set(r.language, r);
}

export function resolverFor(
  lang: CodeGraphLanguage,
): LanguageResolver | undefined {
  return resolvers.get(lang);
}

registerLanguageResolver(typescriptResolver);
registerLanguageResolver(javascriptResolver);
registerLanguageResolver(pythonResolver);
registerLanguageResolver(javaResolver);
registerLanguageResolver(goResolver);
registerLanguageResolver(dartResolver);
