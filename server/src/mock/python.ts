// Runs the team validator (tools/validate_output.py), so mock files pass the same check teammates use.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const VALIDATOR = fileURLToPath(new URL('../../../tools/validate_output.py', import.meta.url));

/** The command that runs Python 3 here (`python3`, `python` or `py -3`), or null if there is none. */
export function findPython(): string[] | null {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const [exe = '', ...args] = cmd;
    const r = spawnSync(exe, [...args, '--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\./.test(r.stdout + r.stderr)) return cmd;
  }
  return null;
}

export type PythonResult = { ok: true } | { ok: false; output: string };

/** Validates all files in one run. Exit code 1 means a file was rejected; anything else is a crash. */
export function validateWithPython(python: readonly string[], files: readonly string[]): PythonResult {
  const [exe = '', ...args] = python;
  const r = spawnSync(exe, [...args, VALIDATOR, ...files], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status === 0) return { ok: true };
  return { ok: false, output: `${r.stdout}${r.stderr}`.trim() || `validator exited with ${String(r.status)}` };
}
