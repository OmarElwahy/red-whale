import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { ingestDocument, ingestText, type IngestResult } from '../src/ingest/ingest';
import type { Db } from '../src/db/client';
import {
  EXAMPLES,
  INVALID_DIR,
  baseDoc,
  counts,
  exampleDoc,
  exampleText,
  freshDb,
  jsonFiles,
  nodeByLabel,
  snapshot,
  type Doc,
  type ExampleName,
} from './helpers';

function ingestExample(db: Db, name: ExampleName): IngestResult {
  return ingestText(db, exampleText(name));
}

function ingestAll(db: Db, names: readonly ExampleName[] = EXAMPLES) {
  return names.map((name) => ingestExample(db, name));
}

function expectIngested(result: IngestResult): Extract<IngestResult, { status: 'ingested' }> {
  if (result.status !== 'ingested') throw new Error(`expected ingested, got ${JSON.stringify(result)}`);
  return result;
}

describe('example files', () => {
  test.each([
    ['subfinder', { nodes: 4, edges: 3, observations: 4 }],
    ['nmap', { nodes: 5, edges: 4, observations: 5 }],
    ['httpx', { nodes: 3, edges: 2, observations: 3 }],
    ['nuclei', { nodes: 3, edges: 2, observations: 3 }],
  ] as const)('%s on its own', (name, expected) => {
    const db = freshDb();
    const result = expectIngested(ingestExample(db, name));
    expect(counts(db)).toEqual({ scans: 1, ...expected });
    expect(result.created).toEqual({ nodes: expected.nodes, edges: expected.edges });
    expect(result.observations).toBe(expected.observations);
    expect(result.warnings).toEqual([]);
  });

  test('all four together: 11 nodes, 11 edges, 15 observations', () => {
    const db = freshDb();
    const results = ingestAll(db).map(expectIngested);
    expect(counts(db)).toEqual({ scans: 4, nodes: 11, edges: 11, observations: 15 });
    expect(results.map((r) => r.created.nodes)).toEqual([4, 4, 1, 2]);
  });

  test('confidence after all four: only nginx is corroborated (nmap and httpx name api/dev only as parents)', () => {
    const db = freshDb();
    ingestAll(db);
    const rows = db.$client
      .prepare('SELECT label, confidence, source_count FROM nodes WHERE confidence = ? ORDER BY label')
      .all('corroborated');
    expect(rows).toEqual([{ label: 'nginx/1.18.0', confidence: 'corroborated', source_count: 2 }]);
    expect(db.$client.prepare("SELECT COUNT(*) AS n FROM nodes WHERE confidence = 'discovered'").get()).toEqual({
      n: 10,
    });
    const sources = db.$client.prepare('SELECT source_count FROM nodes WHERE label = ?');
    expect(sources.get('api.example.com')).toEqual({ source_count: 1 });
    expect(sources.get('dev.example.com')).toEqual({ source_count: 1 });
  });

  test('severity: only the nuclei finding has one', () => {
    const db = freshDb();
    ingestAll(db);
    const rows = db.$client.prepare('SELECT label, severity FROM nodes WHERE severity IS NOT NULL').all();
    expect(rows).toEqual([{ label: 'git-config-exposure', severity: 'medium' }]);
  });

  test('provenance: every tool that reported a node, with the scan and command it came from', () => {
    const db = freshDb();
    const scanIds = ingestAll(db).map((r) => expectIngested(r).scanId);
    const api = nodeByLabel(db, 'api.example.com');
    const rows = db.$client
      .prepare(
        `SELECT o.tool, o.scan_id, s.command, o.data FROM observations o JOIN scans s ON s.id = o.scan_id
         WHERE o.node_id = ? ORDER BY o.observed_at`,
      )
      .all(api.id);
    expect(rows).toEqual([
      {
        tool: 'subfinder',
        scan_id: scanIds[0],
        command: 'subfinder -d example.com -oJ -silent',
        data: '{"source":"crtsh"}',
      },
      { tool: 'nmap', scan_id: scanIds[1], command: expect.stringMatching(/^nmap /) as unknown, data: '{}' },
      { tool: 'httpx', scan_id: scanIds[2], command: expect.stringMatching(/^httpx /) as unknown, data: '{}' },
    ]);

    const raw = db.$client.prepare('SELECT raw FROM scans WHERE id = ?').get(scanIds[1]) as { raw: string };
    expect(JSON.parse(raw.raw)).toEqual(exampleDoc('nmap'));
  });

  test('scan timestamps are stored in fixed-width ISO form', () => {
    const db = freshDb();
    ingestExample(db, 'nmap');
    expect(db.$client.prepare('SELECT started_at, finished_at FROM scans').get()).toEqual({
      started_at: '2026-10-29T10:05:00.000Z',
      finished_at: '2026-10-29T10:07:41.000Z',
    });
  });
});

describe('idempotency', () => {
  test('the same file twice: the second is a duplicate and nothing changes', () => {
    const db = freshDb();
    const first = expectIngested(ingestExample(db, 'nmap'));
    const before = snapshot(db);
    expect(ingestExample(db, 'nmap')).toEqual({ status: 'duplicate', scanId: first.scanId, warnings: [] });
    expect(snapshot(db)).toEqual(before);
  });

  test('a reformatted copy (indent, key order, CRLF) is a duplicate', () => {
    const db = freshDb();
    ingestExample(db, 'subfinder');
    const doc = exampleDoc('subfinder');
    const reordered = Object.fromEntries(Object.entries(doc).reverse());
    const text = JSON.stringify(reordered, null, 4).replace(/\n/g, '\r\n');
    expect(ingestText(db, text).status).toBe('duplicate');
    expect(counts(db).scans).toBe(1);
  });

  test('all examples ingested twice: every second ingest is a duplicate', () => {
    const db = freshDb();
    ingestAll(db);
    const before = snapshot(db);
    expect(ingestAll(db).map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate']);
    expect(snapshot(db)).toEqual(before);
  });

  test('ingest order does not change the result', () => {
    const forward = freshDb();
    const reverse = freshDb();
    ingestAll(forward);
    ingestAll(reverse, [...EXAMPLES].reverse());
    expect(snapshot(reverse)).toEqual(snapshot(forward));
  });

  test('the same node from two scans of the same tool: two observations, still discovered', () => {
    const db = freshDb();
    ingestExample(db, 'subfinder');
    const later = exampleDoc('subfinder');
    later.started_at = '2026-10-30T10:00:00Z';
    later.finished_at = '2026-10-30T10:01:00Z';
    expectIngested(ingestDocument(db, later));

    const api = nodeByLabel(db, 'api.example.com');
    expect(api).toMatchObject({ source_count: 1, confidence: 'discovered' });
    expect(counts(db)).toEqual({ scans: 2, nodes: 4, edges: 3, observations: 8 });
  });

  test('equivalent values merge into one node (https://host:443/ = https://host/)', () => {
    const db = freshDb();
    ingestExample(db, 'httpx');
    const other = exampleDoc('httpx');
    other.tool = 'katana';
    other.findings = [
      {
        type: 'url',
        value: 'https://api.example.com:443/',
        parent: { type: 'subdomain', value: 'api.example.com' },
        relation: 'serves',
      },
    ];
    const result = expectIngested(ingestDocument(db, other));
    expect(result.created).toEqual({ nodes: 0, edges: 0 });
    expect(nodeByLabel(db, 'https://api.example.com/')).toMatchObject({
      value: 'https://api.example.com/',
      source_count: 2,
      confidence: 'corroborated',
    });
  });
});

describe('parent references', () => {
  /** A file from `tool` reporting one subdomain under example.com, which it names only as the parent. */
  function childOfDomain(tool: string, subdomain: string): Doc {
    return baseDoc({
      tool,
      findings: [
        {
          type: 'subdomain',
          value: subdomain,
          parent: { type: 'domain', value: 'example.com' },
          relation: 'has_subdomain',
        },
      ],
    });
  }

  function observationRoles(db: Db, label: string) {
    return db.$client
      .prepare(
        'SELECT o.tool, o.role FROM observations o JOIN nodes n ON n.id = o.node_id WHERE n.label = ? ORDER BY o.tool',
      )
      .all(label);
  }

  test('a node that tools only reference as a parent stays discovered', () => {
    const db = freshDb();
    expectIngested(ingestDocument(db, childOfDomain('subfinder', 'api.example.com')));
    expectIngested(ingestDocument(db, childOfDomain('amass', 'dev.example.com')));

    expect(nodeByLabel(db, 'example.com')).toMatchObject({ source_count: 0, confidence: 'discovered' });
    // Provenance is kept: both tools' references are there, as parent rows.
    expect(observationRoles(db, 'example.com')).toEqual([
      { tool: 'amass', role: 'parent' },
      { tool: 'subfinder', role: 'parent' },
    ]);
  });

  test('only tools that report the node as a finding corroborate it', () => {
    const db = freshDb();
    expectIngested(ingestDocument(db, childOfDomain('subfinder', 'api.example.com')));
    expectIngested(ingestDocument(db, baseDoc({ tool: 'whois', findings: [{ type: 'domain', value: 'example.com' }] })));
    expect(nodeByLabel(db, 'example.com')).toMatchObject({ source_count: 1, confidence: 'discovered' });

    expectIngested(ingestDocument(db, baseDoc({ tool: 'crtsh', findings: [{ type: 'domain', value: 'example.com' }] })));
    expect(nodeByLabel(db, 'example.com')).toMatchObject({ source_count: 2, confidence: 'corroborated' });
  });
});

describe('recomputing derived fields', () => {
  function nmapAt(finishedAt: string, version: string): Doc {
    const doc = exampleDoc('nmap');
    doc.started_at = finishedAt;
    doc.finished_at = finishedAt;
    doc.findings = doc.findings.slice(0, 2); // ip + port 22
    const port = doc.findings[1];
    if (!port) throw new Error('fixture changed');
    port.data = { state: 'open', service: 'ssh', version };
    return doc;
  }

  const older = () => nmapAt('2026-10-29T10:00:00Z', '8.2p1');
  const newer = () => nmapAt('2026-11-05T10:00:00Z', '9.6p1');

  test('newer data wins by observation time, not by ingest order', () => {
    const db = freshDb();
    expectIngested(ingestDocument(db, newer()));
    expectIngested(ingestDocument(db, older()));
    const port = nodeByLabel(db, '93.184.216.34:22/tcp');
    expect(JSON.parse(port.data)).toEqual({ state: 'open', service: 'ssh', version: '9.6p1' });
    expect(port).toMatchObject({ first_seen: '2026-10-29T10:00:00.000Z', last_seen: '2026-11-05T10:00:00.000Z' });
  });

  test('edges keep the earliest first_seen and latest last_seen, whatever the order', () => {
    const db = freshDb();
    expectIngested(ingestDocument(db, newer()));
    expectIngested(ingestDocument(db, older()));
    const rows = db.$client.prepare('SELECT DISTINCT first_seen, last_seen FROM edges').all();
    expect(rows).toEqual([{ first_seen: '2026-10-29T10:00:00.000Z', last_seen: '2026-11-05T10:00:00.000Z' }]);
  });

  test('a verified node stays verified when new observations arrive', () => {
    const db = freshDb();
    ingestExample(db, 'subfinder');
    db.$client.prepare("UPDATE nodes SET confidence = 'verified' WHERE label = 'mail.example.com'").run();

    const more = baseDoc({
      tool: 'amass',
      findings: [
        {
          type: 'subdomain',
          value: 'mail.example.com',
          parent: { type: 'domain', value: 'example.com' },
          relation: 'has_subdomain',
        },
      ],
    });
    expectIngested(ingestDocument(db, more));
    expect(nodeByLabel(db, 'mail.example.com')).toMatchObject({ confidence: 'verified', source_count: 2 });
  });

  test('analyst fields (tag, notes, position) survive a re-ingest of the node', () => {
    const db = freshDb();
    ingestExample(db, 'subfinder');
    db.$client
      .prepare("UPDATE nodes SET tag = 'interesting', notes = 'check this', pos_x = 1, pos_y = 2 WHERE label = ?")
      .run('api.example.com');
    ingestExample(db, 'nmap');
    const row = db.$client.prepare('SELECT tag, notes, pos_x, pos_y FROM nodes WHERE label = ?').get('api.example.com');
    expect(row).toEqual({ tag: 'interesting', notes: 'check this', pos_x: 1, pos_y: 2 });
  });
});

describe('rejected files leave the database untouched', () => {
  test.each(jsonFiles(INVALID_DIR))('contract/invalid/%s', (file) => {
    const db = freshDb();
    const result = ingestText(db, readFileSync(join(INVALID_DIR, file), 'utf8'));
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.errors.length).toBeGreaterThan(0);
    expect(counts(db)).toEqual({ scans: 0, nodes: 0, edges: 0, observations: 0 });
  });

  test('an invalid file after valid data changes nothing', () => {
    const db = freshDb();
    ingestAll(db);
    const before = snapshot(db);
    const result = ingestText(db, readFileSync(join(INVALID_DIR, 'relation-wrong-types.json'), 'utf8'));
    expect(result.status).toBe('invalid');
    expect(snapshot(db)).toEqual(before);
  });

  test('malformed JSON', () => {
    const db = freshDb();
    const result = ingestText(db, '{ "tool": ');
    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') expect(result.errors[0]).toMatch(/^not valid JSON: /);
  });

  test('an unparseable URL host rejects the whole file', () => {
    const db = freshDb();
    const doc = baseDoc({
      findings: [
        { type: 'domain', value: 'example.com' },
        {
          type: 'url',
          value: 'https://bad host.example.com/',
          parent: { type: 'domain', value: 'example.com' },
          relation: 'serves',
        },
      ],
    });
    const result = ingestDocument(db, doc);
    expect(result).toEqual({
      status: 'invalid',
      errors: [expect.stringMatching(/^findings\[1\]\.value: .*URL can't be parsed/)],
    });
    expect(counts(db)).toEqual({ scans: 0, nodes: 0, edges: 0, observations: 0 });
  });

  test('a failure part-way through the transaction rolls everything back', () => {
    const db = freshDb();
    ingestExample(db, 'subfinder');
    const before = snapshot(db);
    db.$client.exec("CREATE TRIGGER fail_edges BEFORE INSERT ON edges BEGIN SELECT RAISE(ABORT, 'boom'); END");
    expect(() => ingestExample(db, 'nmap')).toThrow(/boom/);
    expect(snapshot(db)).toEqual(before);
  });
});

test('a failed scan with no findings is still recorded', () => {
  const db = freshDb();
  const doc = baseDoc({ status: 'failed', errors: ['connection timed out'] });
  const result = expectIngested(ingestDocument(db, doc));
  expect(result).toMatchObject({ nodeIds: [], edgeIds: [], observations: 0, warnings: [] });
  expect(counts(db)).toEqual({ scans: 1, nodes: 0, edges: 0, observations: 0 });
  expect(db.$client.prepare('SELECT status, errors FROM scans').get()).toEqual({
    status: 'failed',
    errors: '["connection timed out"]',
  });
});

test('lint warnings are returned but do not block ingest', () => {
  const db = freshDb();
  const doc = baseDoc({
    findings: [
      {
        type: 'vulnerability',
        value: 'CVE-2021-41773',
        parent: { type: 'url', value: 'https://example.com/' },
        relation: 'has_vulnerability',
      },
    ],
  });
  const result = expectIngested(ingestDocument(db, doc));
  expect(result.warnings).toEqual(['findings[0]: vulnerability has no severity']);
  expect(counts(db).nodes).toBe(2);
});

describe('edge provenance', () => {
  const sub = (value: string) => ({
    type: 'subdomain',
    value,
    parent: { type: 'domain', value: 'example.com' },
    relation: 'has_subdomain',
  });
  const scanBy = (tool: string, finishedAt: string, findings: Record<string, unknown>[]) =>
    baseDoc({ tool, command: `${tool} -d example.com`, started_at: finishedAt, finished_at: finishedAt, findings });

  function edgeObservationRows(db: Db) {
    return db.$client
      .prepare(
        `SELECT e.relation, o.tool, o.data, o.observed_at, o.scan_id = s.id AS scan_matches
         FROM edge_observations o JOIN edges e ON e.id = o.edge_id JOIN scans s ON s.id = o.scan_id
         ORDER BY o.observed_at, o.tool`,
      )
      .all();
  }

  test('every finding with a parent records an edge observation for its scan', () => {
    const db = freshDb();
    const result = expectIngested(ingestDocument(db, scanBy('subfinder', '2026-10-29T10:00:00Z', [sub('api.example.com')])));
    expect(result.edgeObservations).toBe(1);
    expect(edgeObservationRows(db)).toEqual([
      { relation: 'has_subdomain', tool: 'subfinder', data: '{}', observed_at: '2026-10-29T10:00:00.000Z', scan_matches: 1 },
    ]);
  });

  test('the same edge from two tools: one row per scan', () => {
    const db = freshDb();
    ingestDocument(db, scanBy('subfinder', '2026-10-29T10:00:00Z', [sub('api.example.com')]));
    ingestDocument(db, scanBy('amass', '2026-10-29T11:00:00Z', [sub('api.example.com')]));
    expect(counts(db).edges).toBe(1);
    expect(edgeObservationRows(db).map((r) => (r as { tool: string }).tool)).toEqual(['subfinder', 'amass']);
  });

  test('the same edge twice in one file: one row', () => {
    const db = freshDb();
    const doc = scanBy('subfinder', '2026-10-29T10:00:00Z', [sub('api.example.com'), { ...sub('api.example.com'), data: { source: 'crtsh' } }]);
    expect(expectIngested(ingestDocument(db, doc)).edgeObservations).toBe(1);
    expect(edgeObservationRows(db)).toHaveLength(1);
  });

  test('re-ingesting a file adds no edge observations', () => {
    const db = freshDb();
    ingestAll(db);
    const before = db.$client.prepare('SELECT COUNT(*) AS n FROM edge_observations').get();
    expect(before).toEqual({ n: 11 });
    ingestAll(db);
    expect(db.$client.prepare('SELECT COUNT(*) AS n FROM edge_observations').get()).toEqual(before);
  });

  const edgeRows = (db: Db) =>
    db.$client.prepare('SELECT relation, confidence, source_count, first_seen, last_seen FROM edges ORDER BY id').all();

  test('the same edge from two tools: source_count 2, corroborated, seen from the first to the last scan', () => {
    const db = freshDb();
    ingestDocument(db, scanBy('subfinder', '2026-10-29T10:00:00Z', [sub('api.example.com'), sub('dev.example.com')]));
    ingestDocument(db, scanBy('amass', '2026-10-29T11:00:00Z', [sub('api.example.com')]));
    expect(edgeRows(db)).toEqual(
      expect.arrayContaining([
        {
          relation: 'has_subdomain',
          confidence: 'corroborated',
          source_count: 2,
          first_seen: '2026-10-29T10:00:00.000Z',
          last_seen: '2026-10-29T11:00:00.000Z',
        },
        {
          relation: 'has_subdomain',
          confidence: 'discovered',
          source_count: 1,
          first_seen: '2026-10-29T10:00:00.000Z',
          last_seen: '2026-10-29T10:00:00.000Z',
        },
      ]),
    );
  });

  test('two scans of the same tool: still discovered, last seen moves on', () => {
    const db = freshDb();
    ingestDocument(db, scanBy('subfinder', '2026-10-29T10:00:00Z', [sub('api.example.com')]));
    ingestDocument(db, scanBy('subfinder', '2026-10-30T10:00:00Z', [sub('api.example.com')]));
    expect(edgeRows(db)).toEqual([
      {
        relation: 'has_subdomain',
        confidence: 'discovered',
        source_count: 1,
        first_seen: '2026-10-29T10:00:00.000Z',
        last_seen: '2026-10-30T10:00:00.000Z',
      },
    ]);
  });

  test('ingest order A then B vs B then A: identical edges and edge observations', () => {
    const a = scanBy('subfinder', '2026-10-29T10:00:00Z', [sub('api.example.com'), sub('dev.example.com')]);
    const b = scanBy('amass', '2026-10-28T10:00:00Z', [sub('api.example.com')]);
    const ab = freshDb();
    const ba = freshDb();
    ingestDocument(ab, a);
    ingestDocument(ab, b);
    ingestDocument(ba, b);
    ingestDocument(ba, a);
    expect(snapshot(ba).edges).toEqual(snapshot(ab).edges);
    expect(snapshot(ba).edgeObservations).toEqual(snapshot(ab).edgeObservations);
    expect(snapshot(ab).edges).toEqual(
      expect.arrayContaining([expect.objectContaining({ source_count: 2, first_seen: '2026-10-28T10:00:00.000Z' })]),
    );
  });

  test('re-ingesting a file changes no edge field', () => {
    const db = freshDb();
    ingestAll(db);
    const before = edgeRows(db);
    ingestAll(db);
    expect(edgeRows(db)).toEqual(before);
  });

  test('the example files: every edge is reported by exactly one tool, so discovered', () => {
    const db = freshDb();
    ingestAll(db);
    const rows = db.$client.prepare('SELECT DISTINCT confidence, source_count FROM edges').all();
    expect(rows).toEqual([{ confidence: 'discovered', source_count: 1 }]);
  });

  test('a finding without a parent records none', () => {
    const db = freshDb();
    ingestDocument(db, scanBy('subfinder', '2026-10-29T10:00:00Z', [{ type: 'domain', value: 'example.com' }]));
    expect(edgeObservationRows(db)).toEqual([]);
  });
});
