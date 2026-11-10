import type { CodeGraphLanguage } from '../../../../../shared/domain/code-graph';

/** Product names: shown as-is in every UI language. */
export const LANGUAGE_NAMES: Record<CodeGraphLanguage, string> = {
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  java: 'Java',
  go: 'Go',
  dart: 'Dart',
};

export const SUPPORTED_LANGUAGE_NAMES: readonly string[] = ['TypeScript/JavaScript', 'Python', 'Java', 'Dart', 'Go'];
