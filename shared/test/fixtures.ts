import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const REPO_ROOT = resolve(import.meta.dirname, '../..');
export const EXAMPLES_DIR = join(REPO_ROOT, 'contract/examples');
export const INVALID_DIR = join(REPO_ROOT, 'contract/invalid');

export function jsonFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

/** A small valid file; tests clone and mutate it. */
export function baseDoc(): Record<string, unknown> & { findings: Record<string, unknown>[] } {
  return {
    contract_version: 1,
    tool: 'testtool',
    target: 'example.com',
    command: 'testtool example.com',
    started_at: '2026-10-29T10:00:00Z',
    finished_at: '2026-10-29T10:01:00Z',
    status: 'success',
    errors: [],
    findings: [
      { type: 'domain', value: 'example.com' },
      {
        type: 'subdomain',
        value: 'api.example.com',
        parent: { type: 'domain', value: 'example.com' },
        relation: 'has_subdomain',
      },
    ],
  };
}
