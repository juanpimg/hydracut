// ESLint flat config for HydraCut Studio.
//
// `npm run lint` == `eslint .` — wired into CI (`.github/workflows/ci.yml`).
//
// What is enabled and why:
// - `@eslint/js` recommended: base JS rules for every file.
// - `typescript-eslint` recommended (NOT strict/type-checked): TS rules that
//   the codebase already honours. Kept fast on purpose (no type-aware lint).
// - `eslint-plugin-react-hooks`: makes the three
//   `eslint-disable-next-line react-hooks/exhaustive-deps` comments in
//   `src/components/` meaningful (intentional mount-once effects).
// - `@typescript-eslint/no-explicit-any` stays ON for production code. It is
//   turned OFF only under `src/tests/**`, where `any` test-doubles are the
//   established pattern (mocked canvas contexts, fake stores, …); banning it
//   there would add dozens of disable comments with zero behaviour benefit.
//
// Every rule turned off below names its reason next to it.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'dist/**',
      'coverage/**',
      'node_modules/**',
      'test-artifacts/**',
      // Local agent tooling (gitignored, see .gitignore): vendored browser
      // scripts with their own conventions, not project source.
      '.agents/**',
      '.code-review-graph/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      // Mount-once / reset-on-id-change effects are intentional; violations
      // are suppressed locally with an explanatory disable comment.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  // `_`-prefixed names are the "intentionally unused" convention
  // (mock signatures, placeholder callbacks); `ignoreRestSiblings`
  // covers the `const { dropped, ...rest } = obj` omit idiom.
  // NOTE: the base `no-unused-vars` stays OFF for TypeScript (as
  // `typescript-eslint` configures it): it misfires on parameters that only
  // exist in type positions, e.g. `(chunk: unknown) => void`.
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  },
  // `any` test-doubles are the established pattern of the unit suites.
  {
    files: ['src/tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
  // Plain-Node scripts (dev-server orchestration, E2E runner): Node globals
  // apply alongside the browser globals used inside `page.evaluate`
  // callbacks (those functions run in Chrome, not in Node).
  {
    files: ['scripts/**/*.mjs', 'src/tests/browser/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser,
      },
    },
    rules: {
      // Plain `.mjs` scripts are checked by the base rule only: the TS
      // variant would report the same issue twice.
      '@typescript-eslint/no-unused-vars': 'off',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
    },
  }
);
