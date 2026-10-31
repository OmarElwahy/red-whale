// The scope guard's structural rules (docs/architecture.md §10): only the runner talks to Docker or starts
// programs, and only authorize() makes a ScopedTarget. `pnpm test` checks both, not just `pnpm lint`.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ESLint, type Linter } from 'eslint';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { REPO_ROOT } from './helpers';

// The paths come from the lint config itself, so the test and the rules can't disagree. It's untyped JS: narrow it.
const { AUTHORIZE_FILE, RUNNER_FILE } = z
  .object({ AUTHORIZE_FILE: z.string(), RUNNER_FILE: z.string() })
  .parse(await import(pathToFileURL(join(REPO_ROOT, 'eslint.config.js')).href));

const THIS_FILE = 'server/test/guard.test.ts';

function sourceFiles(dir: string): string[] {
  return readdirSync(join(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return ['node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(path);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
}

describe('dockerode is only ever used by the runner', () => {
  test('no source file outside the runner mentions it (whatever lint says)', () => {
    const files = ['shared', 'server', 'web', 'scripts'].flatMap(sourceFiles);
    expect(files.length).toBeGreaterThan(50);
    const offenders = files
      .filter((f) => f !== RUNNER_FILE && f !== THIS_FILE)
      .filter((f) => /dockerode|docker-modem/.test(readFileSync(join(REPO_ROOT, f), 'utf8')));
    expect(offenders).toEqual([]);
  });

  test('the runner file is where the docs say', () => {
    expect(RUNNER_FILE).toBe('server/src/runner/docker.ts');
    expect(relative(REPO_ROOT, join(REPO_ROOT, AUTHORIZE_FILE)).replaceAll('\\', '/')).toBe('server/src/scope/authorize.ts');
  });
});

describe('lint rules', () => {
  const eslint = new ESLint({ cwd: REPO_ROOT });

  /** Guard-rule messages for `code` linted as if it were the file at `path` (which must exist, for type info). */
  async function guardMessages(code: string, path: string): Promise<Linter.LintMessage[]> {
    const [result] = await eslint.lintText(code, { filePath: join(REPO_ROOT, path) });
    return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports' || m.ruleId === 'no-restricted-syntax');
  }

  test.each([
    ["import Docker from 'dockerode';\nexport { Docker };", 'server/src/app.ts'],
    ["import type Docker from 'dockerode';\nexport type { Docker };", 'server/src/graph/store.ts'],
    ["export { default } from 'dockerode';", 'server/src/app.ts'],
    ["import modem from 'docker-modem/lib/modem';\nexport { modem };", 'server/src/app.ts'],
    ["export const docker = await import('dockerode');", 'server/src/app.ts'],
    ["declare const require: (m: string) => unknown;\nexport const docker = require('dockerode');", 'server/src/app.ts'],
    ["import Docker from 'dockerode';\nexport { Docker };", 'web/src/main.tsx'],
    ["import Docker from 'dockerode';\nexport { Docker };", 'shared/src/index.ts'],
    ["import Docker from 'dockerode';\nexport { Docker };", AUTHORIZE_FILE],
    ["import Docker from 'dockerode';\nexport { Docker };", 'server/src/mock/python.ts'],
    ["import Docker from 'dockerode';\nexport { Docker };", 'server/test/helpers.ts'],
  ])('Docker outside the runner is an error: %j in %s', async (code, path) => {
    const messages = await guardMessages(code, path);
    expect(messages.map((m) => m.message)).toContainEqual(expect.stringContaining(`Only ${RUNNER_FILE} may talk to Docker`));
  });

  test.each([
    ["import { spawn } from 'node:child_process';\nexport { spawn };", 'server/src/app.ts'],
    ["import { execFile } from 'child_process';\nexport { execFile };", 'server/src/routes/scope.ts'],
    ["import { spawn } from 'node:child_process';\nexport { spawn };", 'shared/src/index.ts'],
  ])('starting programs outside the runner is an error: %j in %s', async (code, path) => {
    const messages = await guardMessages(code, path);
    expect(messages.map((m) => m.message)).toContainEqual(expect.stringContaining("Starting programs is the runner's job"));
  });

  test('the Python validator wrapper and tests may start programs (they never touch a target)', async () => {
    const code = "import { spawnSync } from 'node:child_process';\nexport { spawnSync };";
    expect(await guardMessages(code, 'server/src/mock/python.ts')).toEqual([]);
    expect(await guardMessages(code, 'shared/test/parity.test.ts')).toEqual([]);
  });

  test.each([
    ["import type { ScopedTarget } from './scope/authorize';\nexport const t = {} as ScopedTarget;", 'server/src/app.ts'],
    ["import type { ScopedTarget } from './scope/authorize';\nexport const t = {} as unknown as ScopedTarget;", 'server/src/app.ts'],
    ["import type { ScopedTarget } from '../src/scope/authorize';\nexport const t = {} as ScopedTarget;", 'server/test/helpers.ts'],
  ])('casting to ScopedTarget is an error outside authorize(): %j', async (code, path) => {
    const messages = await guardMessages(code, path);
    expect(messages.map((m) => m.message)).toContainEqual(expect.stringContaining('never cast to one'));
  });

  test('authorize.ts may cast (it is the producer)', async () => {
    const code = "type ScopedTarget = { a: 1 };\nexport const t = {} as ScopedTarget;";
    expect(await guardMessages(code, AUTHORIZE_FILE)).toEqual([]);
  });

  // The runner doesn't exist yet, so read its config rather than lint it (type-aware linting needs the file).
  test('the runner file may import Docker and start programs; other runner files may only start programs', async () => {
    const runner = (await eslint.calculateConfigForFile(join(REPO_ROOT, RUNNER_FILE))) as Linter.Config;
    expect((runner.rules?.['no-restricted-imports'] as unknown[] | undefined)?.[0]).toBe(0);
    expect(JSON.stringify(runner.rules?.['no-restricted-syntax'])).not.toContain('dockerode');
    expect(JSON.stringify(runner.rules?.['no-restricted-syntax'])).toContain('ScopedTarget');

    const other = (await eslint.calculateConfigForFile(join(REPO_ROOT, 'server/src/runner/queue.ts'))) as Linter.Config;
    const imports = JSON.stringify(other.rules?.['no-restricted-imports']);
    expect(imports).toContain('dockerode');
    expect(imports).not.toContain('child_process');
  });
}, 120_000);
