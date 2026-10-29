import fc from 'fast-check';
import { describe, expect, test } from 'vitest';
import { NormalizeError, checkValue, normalize, type NodeType } from '../src';

describe('normalize: table', () => {
  test.each<[NodeType, string, string]>([
    // every type trims
    ['domain', '  example.com \n', 'example.com'],
    ['secret', '  AWS key in app.js ', 'AWS key in app.js'],
    ['leak', '\tLinkedIn-2016 ', 'LinkedIn-2016'],

    // domains / subdomains: lowercase, strip trailing dots
    ['domain', 'Example.COM', 'example.com'],
    ['domain', 'example.com.', 'example.com'],
    ['subdomain', 'API.Example.com..', 'api.example.com'],
    ['subdomain', '_dmarc.example.com', '_dmarc.example.com'],

    // email: lowercase
    ['email', 'Admin@Example.COM', 'admin@example.com'],

    // ip
    ['ip', '93.184.216.34', '93.184.216.34'],
    ['ip', '2001:0DB8:0000:0000:0000:0000:0000:0001', '2001:db8::1'],
    ['ip', '2001:DB8::1', '2001:db8::1'],
    ['ip', '0:0:0:0:0:0:0:0', '::'],
    ['ip', '2001:db8:0:0:1:0:0:1', '2001:db8::1:0:0:1'],
    ['ip', '[2001:db8::1]', '2001:db8::1'],
    ['ip', '::ffff:1.2.3.4', '1.2.3.4'],
    ['ip', '::FFFF:0102:0304', '1.2.3.4'],
    ['ip', 'fe80::1%eth0', 'fe80::1%eth0'],

    // port
    ['port', '93.184.216.34:443/tcp', '93.184.216.34:443/tcp'],
    ['port', '93.184.216.34:0443/TCP', '93.184.216.34:443/tcp'],
    ['port', '2001:DB8::1:443/tcp', '[2001:db8::1]:443/tcp'],
    ['port', '[2001:0db8::0001]:53/udp', '[2001:db8::1]:53/udp'],
    ['port', '[1.2.3.4]:80/tcp', '1.2.3.4:80/tcp'],
    ['port', '::ffff:1.2.3.4:80/tcp', '1.2.3.4:80/tcp'],

    // url
    ['url', 'https://A.Example.com', 'https://a.example.com/'],
    ['url', 'https://a.example.com:443/x', 'https://a.example.com/x'],
    ['url', 'http://a.example.com:80/x', 'http://a.example.com/x'],
    ['url', 'http://a.example.com:443/x', 'http://a.example.com:443/x'],
    ['url', 'https://a.example.com:8443/x', 'https://a.example.com:8443/x'],
    ['url', 'https://a.example.com/x#section', 'https://a.example.com/x'],
    ['url', 'https://a.example.com/x#', 'https://a.example.com/x'],
    ['url', 'https://a.example.com./x', 'https://a.example.com/x'],
    ['url', 'https://a.example.com/Login?Next=/Home&b=2', 'https://a.example.com/Login?Next=/Home&b=2'],
    ['url', 'https://a.example.com/dir/', 'https://a.example.com/dir/'],
    ['url', 'https://a.example.com?q=1', 'https://a.example.com/?q=1'],
    ['url', 'http://[2001:DB8::1]:80/', 'http://[2001:db8::1]/'],

    // technology: lowercase so tools agree on case
    ['technology', 'Nginx/1.18.0', 'nginx/1.18.0'],
    ['technology', 'nginx', 'nginx'],

    // vulnerability: CVE IDs uppercase, template IDs untouched
    ['vulnerability', 'cve-2021-41773', 'CVE-2021-41773'],
    ['vulnerability', 'CVE-2021-41773', 'CVE-2021-41773'],
    ['vulnerability', 'git-config-exposure', 'git-config-exposure'],
    ['vulnerability', 'cve-2021-41773-lfi', 'cve-2021-41773-lfi'],

    // certificate: lowercase, no colons
    [
      'certificate',
      '3A:7B:D3:E2:36:0A:3D:29:EE:A4:36:FC:FB:7E:44:C7:35:D1:17:C4:2D:1C:18:35:42:0B:6B:99:42:DD:4F:1B',
      '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b',
    ],

    // secret / leak keep their case
    ['secret', 'AWS access key in /static/app.js', 'AWS access key in /static/app.js'],
  ])('%s %j -> %j', (type, input, expected) => {
    expect(normalize(type, input)).toBe(expected);
  });
});

describe('normalize: rejects what it cannot canonicalize', () => {
  test.each<[NodeType, string]>([
    ['domain', '   '],
    ['ip', 'not-an-ip'],
    ['ip', '010.0.0.1'], // ambiguous (octal?), so refuse rather than guess
    ['ip', '127.1'],
    ['port', '1.2.3.4:443'],
    ['port', '1.2.3.4:0/tcp'],
    ['port', '1.2.3.4:70000/tcp'],
    ['url', 'not a url'],
    ['url', 'example.com/path'],
  ])('%s %j', (type, input) => {
    expect(() => normalize(type, input)).toThrow(NormalizeError);
  });
});

// ---- property tests ----

const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const tld = fc.stringMatching(/^[a-z]{2,6}$/);
const hostname = fc
  .tuple(fc.array(label, { minLength: 1, maxLength: 4 }), tld)
  .map(([labels, t]) => [...labels, t].join('.'));
const hexFingerprint = fc.stringMatching(/^[0-9a-f]{64}$/);
const emailAddr = fc
  .tuple(fc.stringMatching(/^[a-z0-9._%+-]{1,12}$/), hostname)
  .map(([local, host]) => `${local}@${host}`);
const ip = fc.oneof(fc.ipV4(), fc.ipV6());
const portValue = fc
  .tuple(ip, fc.integer({ min: 1, max: 65535 }), fc.constantFrom('tcp', 'udp'))
  .map(([addr, n, proto]) => `${addr.includes(':') ? `[${addr}]` : addr}:${String(n)}/${proto}`);
const urlValue = fc
  .tuple(
    fc.constantFrom('http', 'https'),
    hostname,
    fc.option(fc.integer({ min: 1, max: 65535 }), { nil: undefined }),
    fc.array(fc.stringMatching(/^[A-Za-z0-9._~-]{1,8}$/), { maxLength: 4 }),
    fc.option(fc.stringMatching(/^[A-Za-z0-9=&]{1,10}$/), { nil: undefined }),
    fc.option(fc.stringMatching(/^[A-Za-z0-9]{0,6}$/), { nil: undefined }),
  )
  .map(([scheme, host, port, segments, query, fragment]) => {
    const authority = port === undefined ? host : `${host}:${String(port)}`;
    return (
      `${scheme}://${authority}/${segments.join('/')}` +
      (query === undefined ? '' : `?${query}`) +
      (fragment === undefined ? '' : `#${fragment}`)
    );
  });

/** Contract-valid values for each type that has a strict format. */
const validValues: [NodeType, fc.Arbitrary<string>][] = [
  ['domain', hostname],
  ['subdomain', hostname],
  ['ip', ip],
  ['port', portValue],
  ['url', urlValue],
  ['email', emailAddr],
  ['certificate', hexFingerprint],
];

/** Make a value sloppy in ways normalization should undo. */
function messUp(type: NodeType, value: string, upper: boolean[], pad: string): string {
  let v = value;
  if (type === 'domain' || type === 'subdomain' || type === 'email' || type === 'certificate' || type === 'ip') {
    v = Array.from(v, (ch, i) => (upper[i % upper.length] ? ch.toUpperCase() : ch)).join(''); // values are ASCII
  }
  if (type === 'domain' || type === 'subdomain') v += '.';
  return `${pad}${v}${pad}`;
}

describe('normalize: properties', () => {
  test.each(validValues)('%s: normalizing twice equals normalizing once', (type, arb) => {
    fc.assert(
      fc.property(arb, (value) => {
        const once = normalize(type, value);
        expect(normalize(type, once)).toBe(once);
      }),
    );
  });

  test.each(validValues)('%s: normalized output still passes the contract value check', (type, arb) => {
    fc.assert(
      fc.property(arb, (value) => {
        expect(checkValue(type, normalize(type, value))).toBeNull();
      }),
    );
  });

  test.each(validValues)('%s: sloppy input normalizes to the same value as clean input', (type, arb) => {
    fc.assert(
      fc.property(
        arb,
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        fc.constantFrom('', ' ', '\t', ' \n'),
        (value, upper, pad) => {
          expect(normalize(type, messUp(type, value, upper, pad))).toBe(normalize(type, value));
        },
      ),
    );
  });

  test('free-text types: idempotent for any non-blank string', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<NodeType>('technology', 'vulnerability', 'secret', 'leak'),
        fc.string({ minLength: 1 }).filter((s) => s.trim() !== ''),
        (type, value) => {
          const once = normalize(type, value);
          expect(normalize(type, once)).toBe(once);
        },
      ),
    );
  });
});
