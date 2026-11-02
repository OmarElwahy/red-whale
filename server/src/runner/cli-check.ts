// `pnpm tools:check <tool|--all> [--update]`: the self-check teammates run before handing in a tool
// (docs/team-guide.md). First the tool definitions are checked with the server's own rules (the Zod schema and the
// catalog's consistency checks: exactly what makes the server turn the runner off), then tools/check.py checks the
// script against its saved fixture. Nothing touches a target: the tool itself never runs.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findPython } from '../mock/python';
import { CatalogError, TOOLS_DIR, loadCatalog } from './catalog';

function main(args: string[]): number {
  try {
    const catalog = loadCatalog();
    console.log(`✓ tool definitions: ${String(catalog.tools().length)} tools in ${String(catalog.groups.length)} group(s) load as the server loads them`);
  } catch (e) {
    if (!(e instanceof CatalogError)) throw e;
    console.log('✗ tool definitions: the server would refuse these (and turn the tool runner off):');
    for (const issue of e.issues) console.log(`    ${issue}`);
    return 1;
  }
  const python = findPython();
  if (!python) {
    console.log('✗ no Python 3 found (tried python3, python, py -3)');
    return 1;
  }
  const [exe = '', ...pre] = python;
  const r = spawnSync(exe, [...pre, '-I', join(TOOLS_DIR, 'check.py'), ...args], {
    stdio: 'inherit',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  return r.status ?? 1;
}

process.exitCode = main(process.argv.slice(2).filter((a) => a !== '--'));
