import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';
import { javascriptResolver, typescriptResolver } from './import-resolver';

export interface ResolveContext {
  root: string;
  fileExists(rel: string): boolean;
  listFiles(): string[];
}

export interface LanguageResolver {
  language: CodeGraphLanguage;
  /** Root-relative path of an indexed file, or undefined (external package, missing file). */
  resolveImport(
    fromFile: string,
    spec: string,
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
