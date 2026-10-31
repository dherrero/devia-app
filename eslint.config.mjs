// Flat config (ESLint 10). Same rule set the previous `.eslintrc.json` resolved
// to through `@nx/typescript` + `@nx/angular`, written out explicitly so the
// Nx plugins are no longer needed just to lint.
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import angularPlugin from '@angular-eslint/eslint-plugin';
import angularTemplatePlugin from '@angular-eslint/eslint-plugin-template';
import angularTemplateParser from '@angular-eslint/template-parser';

const coreRules = {
  'no-var': 'error',
  'prefer-const': 'error',
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'for-direction': 'error',
  'no-async-promise-executor': 'error',
  'no-case-declarations': 'error',
  'no-compare-neg-zero': 'error',
  'no-cond-assign': 'error',
  'no-constant-condition': 'error',
  'no-control-regex': 'error',
  'no-debugger': 'error',
  'no-delete-var': 'error',
  'no-dupe-else-if': 'error',
  'no-duplicate-case': 'error',
  'no-empty': 'error',
  'no-empty-character-class': 'error',
  'no-empty-pattern': 'error',
  'no-ex-assign': 'error',
  'no-extra-boolean-cast': 'error',
  'no-fallthrough': 'error',
  'no-global-assign': 'error',
  'no-inner-declarations': 'error',
  'no-invalid-regexp': 'error',
  'no-irregular-whitespace': 'error',
  'no-loss-of-precision': 'error',
  'no-misleading-character-class': 'error',
  'no-nonoctal-decimal-escape': 'error',
  'no-octal': 'error',
  'no-prototype-builtins': 'error',
  'no-regex-spaces': 'error',
  'no-self-assign': 'error',
  'no-shadow-restricted-names': 'error',
  'no-sparse-arrays': 'error',
  'no-unsafe-finally': 'error',
  'no-unsafe-optional-chaining': 'error',
  'no-unused-labels': 'error',
  'no-useless-backreference': 'error',
  'no-useless-catch': 'error',
  'no-useless-escape': 'error',
  'require-yield': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
};

const tsRules = {
  '@typescript-eslint/adjacent-overload-signatures': 'error',
  '@typescript-eslint/ban-ts-comment': 'error',
  '@typescript-eslint/no-array-constructor': 'error',
  '@typescript-eslint/no-duplicate-enum-values': 'error',
  '@typescript-eslint/no-empty-function': 'error',
  '@typescript-eslint/no-empty-interface': 'error',
  '@typescript-eslint/no-empty-object-type': 'error',
  '@typescript-eslint/no-explicit-any': 'warn',
  '@typescript-eslint/no-extra-non-null-assertion': 'error',
  '@typescript-eslint/no-inferrable-types': 'error',
  '@typescript-eslint/no-misused-new': 'error',
  '@typescript-eslint/no-namespace': 'error',
  '@typescript-eslint/no-non-null-asserted-optional-chain': 'error',
  '@typescript-eslint/no-non-null-assertion': 'warn',
  '@typescript-eslint/no-this-alias': 'error',
  '@typescript-eslint/no-unnecessary-type-constraint': 'error',
  '@typescript-eslint/no-unsafe-declaration-merging': 'error',
  '@typescript-eslint/no-unsafe-function-type': 'error',
  '@typescript-eslint/no-unused-expressions': 'error',
  '@typescript-eslint/no-unused-vars': 'warn',
  '@typescript-eslint/no-wrapper-object-types': 'error',
  '@typescript-eslint/prefer-as-const': 'error',
  '@typescript-eslint/prefer-namespace-keyword': 'error',
  '@typescript-eslint/triple-slash-reference': 'error',
};

export default [
  {
    ignores: ['dist/**', 'release/**', 'coverage/**', 'node_modules/**', '.angular/**', 'tmp/**'],
  },
  {
    // The old eslintrc did not report stale disable comments; keep it that way.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: { ...coreRules, ...tsRules },
  },
  {
    files: ['src/renderer/**/*.ts'],
    plugins: { '@angular-eslint': angularPlugin, '@angular-eslint/template': angularTemplatePlugin },
    processor: angularTemplatePlugin.processors['extract-inline-html'],
    rules: {
      '@angular-eslint/directive-selector': [
        'error',
        { type: 'attribute', prefix: 'ds', style: 'camelCase' },
      ],
      '@angular-eslint/component-selector': [
        'error',
        { type: 'element', prefix: 'ds', style: 'kebab-case' },
      ],
      '@angular-eslint/contextual-lifecycle': 'error',
      '@angular-eslint/no-empty-lifecycle-method': 'error',
      '@angular-eslint/no-input-rename': 'error',
      '@angular-eslint/no-inputs-metadata-property': 'error',
      '@angular-eslint/no-output-native': 'error',
      '@angular-eslint/no-output-on-prefix': 'error',
      '@angular-eslint/no-output-rename': 'error',
      '@angular-eslint/no-outputs-metadata-property': 'error',
      '@angular-eslint/prefer-inject': 'error',
      '@angular-eslint/prefer-standalone': 'error',
      '@angular-eslint/use-pipe-transform-interface': 'error',
      '@angular-eslint/use-lifecycle-interface': 'warn',
    },
  },
  {
    files: ['src/renderer/**/*.html'],
    languageOptions: { parser: angularTemplateParser },
    plugins: { '@angular-eslint/template': angularTemplatePlugin },
    rules: {
      '@angular-eslint/template/banana-in-box': 'error',
      '@angular-eslint/template/eqeqeq': 'error',
      '@angular-eslint/template/no-negated-async': 'error',
      '@angular-eslint/template/prefer-control-flow': 'error',
    },
  },
];
