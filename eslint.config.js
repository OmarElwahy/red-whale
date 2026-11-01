import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import reactHooks from 'eslint-plugin-react-hooks';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// --- the scope guard (docs/architecture.md §10) ------------------------------------------------------
// No code path may run a tool against a target without authorize(). Two things make that checkable:
// only the runner talks to Docker (or starts programs), and only authorize() makes a ScopedTarget.
// server/test/guard.test.ts proves these rules fire, and separately scans the sources for 'dockerode'.

/** The one file that may import Docker's client. It doesn't exist until Phase 6C. */
export const RUNNER_FILE = 'server/src/runner/docker.ts';
export const AUTHORIZE_FILE = 'server/src/scope/authorize.ts';

const DOCKER = `Only ${RUNNER_FILE} may talk to Docker; everything else hands the runner a ScopedTarget from authorize().`;
const SPAWN = 'Starting programs is the runner\'s job (server/src/runner/), behind authorize(). See docs/architecture.md §10.';
const CAST = `A ScopedTarget only comes from authorize() (${AUTHORIZE_FILE}); never cast to one.`;

const dockerPaths = ['dockerode', 'docker-modem'].map((name) => ({ name, message: DOCKER }));
const dockerPatterns = [{ group: ['dockerode/*', 'docker-modem/*'], message: DOCKER }];
const spawnPaths = ['node:child_process', 'child_process'].map((name) => ({ name, message: SPAWN }));

const dockerSyntax = [
  { selector: 'ImportExpression[source.value=/^(dockerode|docker-modem)(\\u002F|$)/]', message: DOCKER },
  { selector: "CallExpression[callee.name='require'][arguments.0.value=/^(dockerode|docker-modem)(\\u002F|$)/]", message: DOCKER },
];
const castSyntax = [
  { selector: "TSAsExpression[typeAnnotation.typeName.name='ScopedTarget']", message: CAST },
  { selector: "TSTypeAssertion[typeAnnotation.typeName.name='ScopedTarget']", message: CAST },
];

export default defineConfig(
  globalIgnores(['**/node_modules/', '**/dist/', 'data/', 'output/', 'archive/']),
  {
    files: ['**/*.{ts,tsx,js}'],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      'no-restricted-imports': ['error', { paths: [...dockerPaths, ...spawnPaths], patterns: dockerPatterns }],
      'no-restricted-syntax': ['error', ...dockerSyntax, ...castSyntax],
    },
  },
  {
    // shared/ is also bundled into the browser, so it must not depend on Node built-ins.
    // (Flat config replaces a rule's options per block, so the scope-guard entries are repeated here.)
    files: ['shared/src/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [...dockerPaths, ...spawnPaths],
          patterns: [...dockerPatterns, { group: ['node:*'], message: 'shared/src runs in the browser too.' }],
        },
      ],
    },
  },
  {
    // Starting a program that never touches a target: the team's Python validator (mocks, parity tests).
    files: ['server/src/mock/python.ts', '**/test/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': ['error', { paths: dockerPaths, patterns: dockerPatterns }] },
  },
  {
    // The runner may start programs; of its files, only RUNNER_FILE may import Docker.
    files: ['server/src/runner/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { paths: dockerPaths, patterns: dockerPatterns }] },
  },
  {
    files: [RUNNER_FILE],
    rules: { 'no-restricted-imports': 'off', 'no-restricted-syntax': ['error', ...castSyntax] },
  },
  {
    files: [AUTHORIZE_FILE],
    rules: { 'no-restricted-syntax': ['error', ...dockerSyntax] },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    extends: [reactHooks.configs.flat.recommended],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['**/*.js'],
    extends: [tseslint.configs.disableTypeChecked],
  },
);
