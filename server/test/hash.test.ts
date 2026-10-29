import { expect, test } from 'vitest';
import { canonicalJson, fileHash } from '../src/ingest/hash';
import { exampleDoc, exampleText } from './helpers';

function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([k, v]) => [k, reverseKeys(v)]));
  }
  return value;
}

test('canonical JSON sorts keys at every depth and keeps array order', () => {
  expect(canonicalJson({ b: 1, a: [2, { d: null, c: 'x' }] })).toBe('{"a":[2,{"c":"x","d":null}],"b":1}');
});

test('key order, indentation and CRLF line endings do not change the hash', () => {
  const original = JSON.parse(exampleText('nmap')) as unknown;
  const reformatted = JSON.stringify(reverseKeys(original), null, 4).replace(/\n/g, '\r\n');
  expect(fileHash(JSON.parse(reformatted))).toBe(fileHash(original));
});

test('changing a value or reordering findings changes the hash', () => {
  const original = exampleDoc('subfinder');
  const changed = exampleDoc('subfinder');
  changed.command = 'subfinder -d example.com';
  const reordered = exampleDoc('subfinder');
  reordered.findings.reverse();

  expect(fileHash(changed)).not.toBe(fileHash(original));
  expect(fileHash(reordered)).not.toBe(fileHash(original));
});
