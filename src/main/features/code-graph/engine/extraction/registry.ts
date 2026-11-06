import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';
import type { LanguageExtractor } from './extractor';
import { javaExtractor } from './languages/java';
import { pythonExtractor } from './languages/python';
import { javascriptExtractor, typescriptExtractor } from './languages/typescript';

const extractors = new Map<CodeGraphLanguage, LanguageExtractor>();

export function registerExtractor(e: LanguageExtractor): void {
  extractors.set(e.language, e);
}

export function extractorFor(lang: CodeGraphLanguage): LanguageExtractor | undefined {
  return extractors.get(lang);
}

registerExtractor(typescriptExtractor);
registerExtractor(javascriptExtractor);
registerExtractor(pythonExtractor);
registerExtractor(javaExtractor);
