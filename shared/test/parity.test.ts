// Zod and tools/validate_output.py must agree on pass/fail for every fixture.
// Skipped (visibly) when no Python 3 is installed.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { validateContract } from '../src';
import { EXAMPLES_DIR, INVALID_DIR, REPO_ROOT, baseDoc, jsonFiles, readJson } from './fixtures';

const VALIDATOR = join(REPO_ROOT, 'tools/validate_output.py');

function findPython(): string[] | null {
  for (const cmd of [['python3'], ['python'], ['py', '-3']]) {
    const [exe = '', ...args] = cmd;
    const r = spawnSync(exe, [...args, '--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\./.test(r.stdout + r.stderr)) return cmd;
  }
  return null;
}

const python = findPython();

function pythonAccepts(file: string): boolean {
  const [exe = '', ...args] = python ?? [];
  const r = spawnSync(exe, [...args, VALIDATOR, file], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
  });
  if (r.status !== 0 && r.status !== 1) throw new Error(`validator crashed on ${file}:\n${r.stderr}`);
  return r.status === 0;
}

function zodAccepts(file: string): boolean {
  return validateContract(readJson(file)).ok;
}

describe.skipIf(!python)('parity with tools/validate_output.py', () => {
  test.each(jsonFiles(EXAMPLES_DIR))('examples/%s: both accept', (file) => {
    const path = join(EXAMPLES_DIR, file);
    expect({ python: pythonAccepts(path), zod: zodAccepts(path) }).toEqual({ python: true, zod: true });
  });

  test.each(jsonFiles(INVALID_DIR))('invalid/%s: both reject', (file) => {
    const path = join(INVALID_DIR, file);
    expect({ python: pythonAccepts(path), zod: zodAccepts(path) }).toEqual({ python: false, zod: false });
  });

  describe('edge cases', () => {
    const dir = mkdtempSync(join(tmpdir(), 'redwhale-parity-'));
    afterAll(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    const finding = (type: string, value: string) => () => {
      const doc = baseDoc();
      doc.findings = [{ type, value }];
      return doc;
    };
    const cases: [string, () => unknown][] = [
      ['ipv6', finding('ip', '2001:DB8::1')],
      ['ipv6-zone', finding('ip', 'fe80::1%eth0')],
      ['ipv4-mapped', finding('ip', '::ffff:1.2.3.4')],
      ['port-ipv6-bracketed', finding('port', '[2001:db8::1]:443/tcp')],
      ['port-ipv6-unbracketed', finding('port', '2001:db8::1:443/tcp')],
      ['port-leading-zero', finding('port', '1.2.3.4:080/tcp')],
      ['url-ipv6-host', finding('url', 'http://[::1]/')],
      ['url-fragment', finding('url', 'https://a.example.com:443/x#f')],
      ['url-uppercase-path', finding('url', 'https://a.example.com/Login')],
      ['hostname-underscore', finding('subdomain', '_dmarc.example.com')],
      ['hostname-numeric-tld', finding('domain', 'example.123')],
      ['email-apostrophe', finding('email', "o'brien@example.com")],
      [
        'fraction-seconds',
        () => ({ ...baseDoc(), started_at: '2026-10-29T10:00:00.123Z', finished_at: '2026-10-29T10:00:00.124Z' }),
      ],
      ['null-parent', () => ({ ...baseDoc(), findings: [{ type: 'domain', value: 'example.com', parent: null }] })],
    ];

    test.each(cases)('%s: both agree', (name, make) => {
      const path = join(dir, `${name}.json`);
      writeFileSync(path, JSON.stringify(make()));
      expect(zodAccepts(path)).toBe(pythonAccepts(path));
    });
  });
});
