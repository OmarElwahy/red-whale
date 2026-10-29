import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { NODE_TYPES, NormalizeError, edgeId, nodeId, shortHash, type NodeType } from '../src';

// Computed independently with Python: hashlib.sha256(s.encode()).hexdigest()[:16]
// If any of these change, every existing database's node IDs change with them.
describe('golden vectors', () => {
  test.each<[NodeType, string, string]>([
    ['domain', 'example.com', 'ed152b32b035d8e8'],
    ['subdomain', 'api.example.com', '27fe17251c9e44d4'],
    ['ip', '93.184.216.34', 'a3fea0dc9560477d'],
    ['ip', '2001:db8::1', '9a4ebbd642253f57'],
    ['port', '93.184.216.34:443/tcp', '513136a14b980999'],
    ['port', '[2001:db8::1]:443/tcp', '07902a41fb3ca2a5'],
    ['url', 'https://api.example.com/', 'a88c404c85826185'],
    ['technology', 'nginx/1.18.0', 'b423ac0c5de4c4c4'],
    ['vulnerability', 'CVE-2021-41773', '455f1eadc883365e'],
    ['email', 'admin@example.com', '964ab8ccf3fbc358'],
    ['certificate', '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b', '9f2c63d16731092c'],
    ['secret', 'AWS access key in /static/app.js', '6dbb4f476d3d3cc1'],
    ['leak', 'LinkedIn-2016', '00e6ee1b6aafe363'],
  ])('%s %s', (type, value, id) => {
    expect(nodeId(type, value)).toBe(id);
  });

  test('edge example.com -has_subdomain-> api.example.com', () => {
    expect(edgeId('ed152b32b035d8e8', 'has_subdomain', '27fe17251c9e44d4')).toBe('de92bb3c5da0ecc9');
  });
});

describe('nodeId', () => {
  test('is 16 lowercase hex chars', () => {
    fc.assert(
      fc.property(fc.constantFrom(...NODE_TYPES), fc.string(), (type, value) => {
        expect(shortHash(`${type}:${value}`)).toMatch(/^[0-9a-f]{16}$/);
      }),
    );
  });

  test('is deterministic', () => {
    expect(nodeId('subdomain', 'api.example.com')).toBe(nodeId('subdomain', 'api.example.com'));
  });

  test.each<[NodeType, string, string]>([
    ['subdomain', 'API.Example.com.', 'api.example.com'],
    ['ip', '2001:0DB8::0001', '2001:db8::1'],
    ['ip', '::ffff:93.184.216.34', '93.184.216.34'],
    ['port', '2001:db8::1:443/tcp', '[2001:db8::1]:443/tcp'],
    ['url', 'https://API.example.com:443/#top', 'https://api.example.com/'],
    ['technology', 'Nginx/1.18.0', 'nginx/1.18.0'],
    ['vulnerability', 'cve-2021-41773', 'CVE-2021-41773'],
  ])('%s: %j and %j are the same node', (type, a, b) => {
    expect(nodeId(type, a)).toBe(nodeId(type, b));
  });

  test('the same value under different types gives different IDs', () => {
    expect(nodeId('domain', 'example.com')).not.toBe(nodeId('subdomain', 'example.com'));
  });

  test('nmap and httpx report the same technology node', () => {
    // contract/examples/nmap.example.json and httpx.example.json both report nginx/1.18.0
    expect(nodeId('technology', 'nginx/1.18.0')).toBe(nodeId('technology', 'Nginx/1.18.0'));
  });

  test('throws on values that cannot be normalized', () => {
    expect(() => nodeId('ip', 'nope')).toThrow(NormalizeError);
  });
});

describe('edgeId', () => {
  const a = nodeId('domain', 'example.com');
  const b = nodeId('subdomain', 'api.example.com');

  test('direction matters', () => {
    expect(edgeId(a, 'has_subdomain', b)).not.toBe(edgeId(b, 'has_subdomain', a));
  });

  test('relation matters', () => {
    expect(edgeId(a, 'has_subdomain', b)).not.toBe(edgeId(a, 'resolves_to', b));
  });

  test('is 16 lowercase hex chars', () => {
    expect(edgeId(a, 'has_subdomain', b)).toMatch(/^[0-9a-f]{16}$/);
  });
});
