// Frontend lint configuration.
//
// This one earns its keep more than the backend's. `vite build` does not
// type-check and does not resolve identifiers — an undefined variable inside a
// component compiles cleanly, ships, and throws only when a user navigates to
// that view. The build stays green while the page is blank. `no-undef` closes
// exactly that gap, which is why this runs in CI before the build.
//
// Style rules are excluded on purpose: this codebase uses inline styles and no
// formatter, and a reformat would bury real diffs.
//
// The bar is zero problems, enforced with --max-warnings 0.

import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';

export default [
  {
    ignores: ['node_modules/**', 'dist/**', 'coverage/**', 'playwright-report/**', 'test-results/**'],
  },
  {
    // Stale `eslint-disable` comments predate this config — they suppressed
    // rules that are not enabled here. Reporting them would fail the build for
    // 18 harmless comments. Re-enable alongside the no-unused-vars cleanup.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
      },
    },
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // The reason this config exists — see the header.
      'no-undef': 'error',

      // OFF, deliberately, and not because it is wrong.
      //
      // It reports 1,059 findings today — almost all unused `lucide-react` icon
      // imports and shared-kit components left behind when a page was rewritten.
      // Every one is real dead code and worth removing, but doing it in the same
      // change that introduces the linter would produce a thousand-line diff
      // across every page, which is exactly the reformat-the-world commit that
      // buries real changes and makes `git blame` useless.
      //
      // Enabling it is a task of its own: clean a directory at a time, then flip
      // this to 'error' with the same options the backend uses. Until then the
      // gate below still catches the class that actually crashes a page.
      'no-unused-vars': 'off',

      // Only ever fires here on benign over-escaping inside character classes
      // (`[\-]`, `[\(\)]`), which behaves identically to the unescaped form.
      'no-useless-escape': 'off',

      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      // 'except-parens' keeps the typo check while allowing the deliberate
      // `while ((m = re.exec(s)))` regex-iteration idiom.
      'no-cond-assign': ['error', 'except-parens'],
      'no-control-regex': 'off',
      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],

      // Hooks called conditionally desynchronise React's hook order and corrupt
      // state in ways that present as unrelated components misbehaving.
      'react-hooks/rules-of-hooks': 'error',

      // Left off: this codebase intentionally omits dependencies in places, and
      // turning it on would produce hundreds of findings that drown the errors
      // above. Revisit deliberately, not as a side effect.
      'react-hooks/exhaustive-deps': 'off',

      'no-console': 'off',
    },
  },
  {
    files: ['e2e/**/*.js', 'vite.config*.js', 'vitest.config.js'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/__tests__/**/*.{js,jsx}', '**/*.test.{js,jsx}'],
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
    },
  },
];
