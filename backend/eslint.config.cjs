// Backend lint configuration.
//
// Deliberately narrow. The point of running ESLint here is not style — it is to
// catch the class of mistake that survives review and `node --check`, reaches
// production, and only then throws: a typo'd identifier, a duplicated object key
// that silently discards the first value, an unreachable branch after a return,
// a promise executor that swallows a rejection.
//
// Formatting rules are excluded on purpose. This repo's files were written over
// a long period in visibly different styles, and CLAUDE.md tells contributors to
// match the file they are editing rather than impose one. A formatter here would
// produce a reformat-the-world diff that hides real changes.
//
// The bar is zero problems, enforced in CI with --max-warnings 0. Anything that
// cannot be zero on day one belongs off rather than as a warning nobody reads.

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // An identifier that does not exist is a runtime crash, always. This is
      // the rule the whole config exists for.
      'no-undef': 'error',

      // Unused *variables* usually mean a half-finished edit or a stale import
      // left behind by a partial revert. Unused *arguments* are different:
      // Express needs the four-argument signature for an error handler even
      // when `next` is untouched, so removing them would break routing.
      'no-unused-vars': ['error', {
        args: 'none',
        caughtErrors: 'none',
        varsIgnorePattern: '^_',
      }],

      // `catch {}` with no binding is intentional throughout this codebase
      // (best-effort audit writes, optional integrations). Do not flag it.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Duplicated keys and cases silently discard the earlier value. Both have
      // shipped in real WhatsApp payload switches.
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',

      // `if (x = 1)` — a typo for `===`. 'except-parens' keeps the check while
      // allowing the deliberate `while ((m = re.exec(s)))` regex-iteration
      // idiom, where the extra parentheses are the author saying "I meant this".
      'no-cond-assign': ['error', 'except-parens'],

      // `/^[\x00-\x7F]*$/` is the standard ASCII test and appears in the MIME
      // header encoder. Matching control characters is the point there.
      'no-control-regex': 'off',

      'no-unreachable': 'error',
      'no-self-assign': 'error',
      'no-constant-condition': ['error', { checkLoops: false }],

      // console is the logging strategy here; index.js and every route use it.
      'no-console': 'off',
    },
  },
  {
    // Tests additionally get node:test's globals via imports, so nothing extra
    // is needed — but they may legitimately declare fixtures they do not use in
    // every branch.
    files: ['test/**/*.js'],
    rules: {
      'no-unused-vars': ['error', { args: 'none', caughtErrors: 'none', varsIgnorePattern: '^_' }],
    },
  },
];
