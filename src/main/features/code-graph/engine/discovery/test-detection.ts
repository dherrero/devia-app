import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';

const RULES: Record<CodeGraphLanguage, ReadonlyArray<RegExp>> = {
  typescript: [/\.(?:spec|test)\.[cm]?[jt]sx?$/, /(?:^|\/)__tests__\//],
  javascript: [/\.(?:spec|test)\.[cm]?[jt]sx?$/, /(?:^|\/)__tests__\//],
  python: [/(?:^|\/)test_[^/]*\.py$/, /_test\.py$/, /(?:^|\/)tests\//],
  java: [/Tests?\.java$/, /(?:^|\/)src\/test\//],
  go: [/_test\.go$/],
  dart: [/_test\.dart$/, /(?:^|\/)test\//],
};

export function isTestFile(relPath: string, lang: CodeGraphLanguage): boolean {
  const rel = relPath.replace(/\\/g, '/');
  return RULES[lang].some((re) => re.test(rel));
}
