// The Python side of the tools (tools/lib, tools/<group>/<tool>/test_*.py): their unittest suites run here, so
// `pnpm test` covers the scripts teammates copy. Skipped where there is no Python 3.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { findPython } from '../src/mock/python';
import { TOOLS_DIR } from '../src/runner/catalog';

const python = findPython();

/** Every folder under tools/ that holds a test_*.py. */
function testDirs(dir: string, rel = ''): string[] {
  const here = join(dir, rel);
  const entries = readdirSync(here, { withFileTypes: true });
  const own = entries.some((e) => e.isFile() && /^test_.*\.py$/.test(e.name)) ? [rel] : [];
  const below = entries
    .filter((e) => e.isDirectory() && e.name !== '__pycache__' && e.name !== 'fixtures')
    .flatMap((e) => testDirs(dir, rel ? `${rel}/${e.name}` : e.name));
  return [...own, ...below];
}

describe.skipIf(!python)('python unit tests', () => {
  const dirs = testDirs(TOOLS_DIR);

  test('the helper has tests', () => {
    expect(dirs).toContain('lib');
    expect(existsSync(join(TOOLS_DIR, 'lib/test_redwhale_tool.py'))).toBe(true);
  });

  test.each(dirs)('tools/%s', (dir) => {
    const [exe = '', ...args] = python ?? [];
    const r = spawnSync(exe, [...args, '-I', '-m', 'unittest', 'discover', '-s', join(TOOLS_DIR, dir), '-p', 'test_*.py'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      timeout: 60_000,
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
    expect(r.stderr).toMatch(/Ran [1-9]\d* tests?/);
  });
});
