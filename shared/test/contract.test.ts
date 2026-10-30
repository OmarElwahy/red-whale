import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { RELATIONS, RELATION_TYPES, validateContract } from '../src';
import { EXAMPLES_DIR, INVALID_DIR, baseDoc, jsonFiles, readJson } from './fixtures';

/** Each file in contract/invalid/ and an error line it must produce. */
const INVALID_CASES: Record<string, string> = {
  'top-not-object': 'top level must be a JSON object',
  'top-unknown-field': "unknown top-level field 'extra'",
  'missing-contract-version': "missing required field 'contract_version'",
  'missing-tool': "missing required field 'tool'",
  'missing-target': "missing required field 'target'",
  'missing-command': "missing required field 'command'",
  'missing-started-at': "missing required field 'started_at'",
  'missing-finished-at': "missing required field 'finished_at'",
  'missing-status': "missing required field 'status'",
  'missing-errors': "missing required field 'errors'",
  'missing-findings': "missing required field 'findings'",
  'contract-version-2': 'contract_version: contract_version must be 1',
  'contract-version-string': 'contract_version: contract_version must be 1',
  'contract-version-bool': 'contract_version: contract_version must be 1',
  'tool-uppercase': "tool: 'tool' must be lowercase",
  'tool-version-number': "tool_version: 'tool_version' must be of type str",
  'status-invalid': "status: 'status' must be one of success, partial, failed",
  'errors-not-list': "errors: 'errors' must be of type list",
  'errors-non-string': "errors[0]: 'errors' must be a list of strings",
  'findings-not-list': "findings: 'findings' must be of type list",
  'started-at-no-z': "started_at: 'started_at' must be ISO 8601 UTC ending in Z",
  'started-at-offset': "started_at: 'started_at' must be ISO 8601 UTC ending in Z",
  'started-at-garbage': "started_at: 'started_at' must be ISO 8601 UTC ending in Z",
  'started-at-impossible-date': "started_at: 'started_at' must be ISO 8601 UTC ending in Z",
  'finished-before-started': "finished_at: 'finished_at' is before 'started_at'",
  'finding-not-object': 'findings[0]: must be an object',
  'finding-unknown-field': "findings[1]: unknown field 'source' (put extra details inside 'data')",
  'finding-has-id': 'findings[1]: do not create IDs; the server generates them',
  'finding-bad-type': "findings[1].type: type 'host' is not one of",
  'finding-data-array': "findings[1].data: 'data' must be an object",
  'finding-data-string': "findings[1].data: 'data' must be an object",
  'finding-severity-invalid': 'findings[1].severity: severity must be one of',
  'finding-severity-uppercase': 'findings[1].severity: severity must be one of',
  'subdomain-uppercase': "findings[1].value: subdomain value 'API.example.com' must be lowercase",
  'subdomain-scheme': 'findings[1].value: subdomain value \'https://api.example.com\' must not contain a scheme or path',
  'subdomain-path': 'must not contain a scheme or path',
  'subdomain-trailing-dot': 'must not end with a dot',
  'subdomain-wildcard': 'wildcards like *.example.com are not allowed',
  'subdomain-port': 'must not contain a port',
  'subdomain-bad-label': 'is not a valid hostname',
  'domain-no-dot': "findings[0].value: domain value 'localhost' is not a valid hostname",
  'ip-out-of-range': 'is not a valid IPv4/IPv6 address',
  'ip-leading-zero': 'is not a valid IPv4/IPv6 address',
  'port-no-protocol': 'must look like ip:port/tcp',
  'port-bad-ip': "'93.184.216' is not a valid IP",
  'port-zero': 'port number out of range',
  'port-too-high': 'port number out of range',
  'port-sctp': 'must look like ip:port/tcp',
  'url-no-scheme': 'must be a full URL starting with http:// or https://',
  'url-ftp': 'must be a full URL starting with http:// or https://',
  'url-uppercase-host': 'host part of the URL must be lowercase',
  'url-host-space': "URL can't be parsed: check the host and port",
  'url-port-too-high': "URL can't be parsed: check the host and port",
  'url-host-bad-ipv4': "URL can't be parsed: check the host and port",
  'url-host-non-ascii': "non-ASCII host: convert it to punycode, e.g. host.encode('idna').decode()",
  'url-host-percent': 'host part of the URL must not be percent-encoded',
  'subdomain-non-ascii': "non-ASCII host: convert it to punycode, e.g. host.encode('idna').decode()",
  'email-uppercase': 'must be a valid lowercase email address',
  'email-no-domain': 'must be a valid lowercase email address',
  'certificate-colons': 'must be a SHA-256 fingerprint',
  'certificate-uppercase': 'must be a SHA-256 fingerprint',
  'certificate-short': 'must be a SHA-256 fingerprint',
  'value-empty': "findings[1].value: subdomain value '' value must be a non-empty string",
  'value-whitespace': 'value has leading/trailing spaces',
  'value-not-string': 'findings[1].value: value must be a non-empty string',
  'relation-without-parent': "findings[1].relation: has 'relation' but no 'parent'",
  'parent-without-relation': "findings[1].relation: has 'parent' but no 'relation'",
  'parent-extra-key': `findings[1].parent: 'parent' must be exactly {"type": ..., "value": ...}`,
  'parent-missing-value': `findings[1].parent.value: 'parent' must be exactly {"type": ..., "value": ...}`,
  'parent-bad-type': "findings[1].parent.type: parent type 'host' is not a valid node type",
  'parent-bad-value': "findings[1].parent.value: parent domain value 'Example.com' must be lowercase",
  'relation-unknown': "findings[1].relation: relation 'owns' is not one of",
  'relation-wrong-types': "findings[1].relation: 'has_port' can't link domain -> subdomain (allowed: ip -> port)",
};

function errorsOf(input: unknown): string[] {
  const result = validateContract(input);
  return result.ok ? [] : result.errors;
}

describe('contract/examples', () => {
  test.each(jsonFiles(EXAMPLES_DIR))('%s is valid', (file) => {
    const result = validateContract(readJson(join(EXAMPLES_DIR, file)));
    expect(result).toMatchObject({ ok: true });
  });
});

describe('contract/invalid', () => {
  test('every fixture file has an expected error, and every expected error has a file', () => {
    const files = jsonFiles(INVALID_DIR).map((f) => f.replace(/\.json$/, ''));
    expect(files).toEqual(Object.keys(INVALID_CASES).sort());
  });

  test.each(Object.entries(INVALID_CASES))('%s is rejected', (name, expected) => {
    const errors = errorsOf(readJson(join(INVALID_DIR, `${name}.json`)));
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toContain(expected);
  });
});

describe('valid edge cases', () => {
  test('minimal file: no findings, no tool_version', () => {
    const doc = baseDoc();
    doc.findings = [];
    delete doc.tool_version;
    expect(validateContract(doc)).toMatchObject({ ok: true });
  });

  const pairs = RELATION_TYPES.flatMap((relation) =>
    RELATIONS[relation].parents.flatMap((parentType) =>
      RELATIONS[relation].children.map((childType) => ({ relation, parentType, childType })),
    ),
  );
  const SAMPLE: Record<string, string> = {
    domain: 'example.com',
    subdomain: 'api.example.com',
    ip: '93.184.216.34',
    port: '93.184.216.34:443/tcp',
    url: 'https://api.example.com/',
    technology: 'nginx/1.18.0',
    vulnerability: 'CVE-2021-41773',
    email: 'admin@example.com',
    secret: 'AWS access key in /static/app.js',
    certificate: '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b',
    leak: 'LinkedIn-2016',
  };
  test.each(pairs)('$relation: $parentType -> $childType', ({ relation, parentType, childType }) => {
    const doc = baseDoc();
    doc.findings = [
      {
        type: childType,
        value: SAMPLE[childType],
        parent: { type: parentType, value: SAMPLE[parentType] },
        relation,
        severity: 'info',
      },
    ];
    expect(errorsOf(doc)).toEqual([]);
  });

  test.each([
    ['IPv6 address', 'ip', '2001:db8::1'],
    ['IPv6 address with uppercase hex', 'ip', '2001:DB8::1'],
    ['IPv6 port, bracketed', 'port', '[2001:db8::1]:443/tcp'],
    ['IPv6 port, unbracketed', 'port', '2001:db8::1:443/tcp'],
    ['UDP port', 'port', '93.184.216.34:53/udp'],
    ['URL with port, query and fragment', 'url', 'https://a.example.com:8443/P/a?x=1#top'],
    ['URL with no path', 'url', 'http://example.com'],
    ['URL with a punycode host', 'url', 'https://xn--bcher-kva.example.com/'],
    ['URL with userinfo', 'url', 'http://user@example.com/'],
    ['URL with an IPv4 host', 'url', 'http://10.0.0.1:8080/admin'],
    ['URL with port 65535', 'url', 'http://example.com:65535/'],
    ['URL with a non-ASCII path', 'url', 'https://example.com/bücher?q=%20'],
    ['hostname with underscore', 'subdomain', '_dmarc.example.com'],
  ])('%s', (_label, type, value) => {
    const doc = baseDoc();
    doc.findings = [{ type, value }];
    expect(errorsOf(doc)).toEqual([]);
  });

  test('fractional seconds in timestamps', () => {
    const doc = baseDoc();
    doc.started_at = '2026-10-29T10:00:00.5Z';
    doc.finished_at = '2026-10-29T10:00:00.51Z';
    expect(errorsOf(doc)).toEqual([]);
  });

  test('finished_at equal to started_at', () => {
    const doc = baseDoc();
    doc.finished_at = doc.started_at;
    expect(errorsOf(doc)).toEqual([]);
  });

  test('finished_at earlier only in the fraction is rejected', () => {
    const doc = baseDoc();
    doc.started_at = '2026-10-29T10:00:00.5Z';
    doc.finished_at = '2026-10-29T10:00:00.49Z';
    expect(errorsOf(doc).join('\n')).toContain("'finished_at' is before 'started_at'");
  });

  test('explicit null parent and relation count as absent', () => {
    const doc = baseDoc();
    doc.findings = [{ type: 'subdomain', value: 'api.example.com', parent: null, relation: null }];
    expect(errorsOf(doc)).toEqual([]);
  });

  test('data may hold any JSON', () => {
    const doc = baseDoc();
    doc.findings = [{ type: 'domain', value: 'example.com', data: { a: [1, null, { b: true }], raw: 'x' } }];
    expect(errorsOf(doc)).toEqual([]);
  });
});

describe('error reporting', () => {
  test('reports several problems in one file', () => {
    const doc = baseDoc();
    doc.tool = 'Nmap';
    doc.status = 'done';
    expect(errorsOf(doc)).toHaveLength(2);
  });

  test('reports problems in several findings', () => {
    const doc = baseDoc();
    doc.findings = [
      { type: 'ip', value: 'nope' },
      { type: 'email', value: 'NOPE' },
    ];
    const errors = errorsOf(doc);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/^findings\[0\]\.value:/);
    expect(errors[1]).toMatch(/^findings\[1\]\.value:/);
  });
});

describe('warnings', () => {
  function warningsOf(doc: unknown): string[] {
    const result = validateContract(doc);
    if (!result.ok) throw new Error(result.errors.join('\n'));
    return result.warnings;
  }

  test('a clean file has no warnings', () => {
    expect(warningsOf(baseDoc())).toEqual([]);
  });

  test('failed with empty errors', () => {
    const doc = baseDoc();
    doc.status = 'failed';
    expect(warningsOf(doc)).toContain("status is 'failed' but 'errors' is empty; say what went wrong");
  });

  test('success with no findings', () => {
    const doc = baseDoc();
    doc.findings = [];
    expect(warningsOf(doc)).toContain('no findings; fine if the tool really found nothing');
  });

  test('duplicate finding with the same parent', () => {
    const doc = baseDoc();
    doc.findings.push(structuredClone(baseDoc().findings[1] ?? {}));
    expect(warningsOf(doc)).toContain(
      "findings[2]: duplicate finding subdomain 'api.example.com' with the same parent",
    );
  });

  test('same value under a different parent is not a duplicate', () => {
    const doc = baseDoc();
    doc.findings = [
      { type: 'ip', value: '1.2.3.4', parent: { type: 'subdomain', value: 'a.example.com' }, relation: 'resolves_to' },
      { type: 'ip', value: '1.2.3.4', parent: { type: 'subdomain', value: 'b.example.com' }, relation: 'resolves_to' },
    ];
    expect(warningsOf(doc)).toEqual([]);
  });

  test.each(['vulnerability', 'secret', 'leak'])('%s without severity', (type) => {
    const doc = baseDoc();
    doc.findings = [{ type, value: 'something' }];
    expect(warningsOf(doc)).toContain(`findings[0]: ${type} has no severity`);
  });

  test('parentless port floats alone; parentless domain does not warn', () => {
    const doc = baseDoc();
    doc.findings = [
      { type: 'port', value: '1.2.3.4:80/tcp' },
      { type: 'domain', value: 'example.com' },
    ];
    expect(warningsOf(doc)).toEqual(['findings[0]: port has no parent; it will float alone on the graph']);
  });
});
