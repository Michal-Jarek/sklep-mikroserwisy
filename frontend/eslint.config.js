import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores(['dist', 'playwright-report', 'test-results']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [js.configs.recommended, tseslint.configs.recommended, reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: {
      ecmaVersion: 2022,
      globals: globals.browser,
    },
  },
  {
    // shadcn/ui files export variants next to components; tests, test helpers, E2E and configs are not hot-reloaded modules.
    files: ['src/components/ui/**', '**/*.test.{ts,tsx}', 'src/test/**', 'e2e/**', '*.config.ts'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },
  {
    files: ['e2e/**', '*.config.{ts,js}'],
    languageOptions: { globals: globals.node },
  },
]);
