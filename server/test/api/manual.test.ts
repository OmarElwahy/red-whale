// POST /api/nodes: nodes the analyst adds by hand, through ingest as tool `manual` (graph editing, docs/architecture.md §6).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  edgeDetailResponseSchema,
  manualNodeResponseSchema,
  nodeDetailResponseSchema,
  nodeId,
  wsEventSchema,
  type WsEvent,
} from '@redwhale/shared';
import { describe, expect, test, vi } from 'vitest';
import { runIngestCli } from '../../src/cli/ingest';
import { ingestDocument } from '../../src/ingest/ingest';
import { baseDoc, counts, tempDir } from '../helpers';
import { HOST, body, error, idOf, ingestExamples, testApi, type TestApi } from './helpers';

async function examples(): Promise<TestApi> {
  const api = await testApi();
  ingestExamples(api.db);
  return api;
}

const add = (api: TestApi, payload: Record<string, unknown>) => api.send('POST', '/api/nodes', payload);

describe('adding a node', () => {
  test('201: a root node, discovered with source_count 0, provenance "manual / added by analyst", fields applied', async () => {
    const api = await testApi();
    const res = body(
      await add(api, { type: 'domain', value: 'target.example', label: 'Main target', tag: 'interesting', notes: '**scope** note', x: 12.5, y: -4 }),
      201,
      manualNodeResponseSchema,
    );
    expect(res).toEqual({ id: nodeId('domain', 'target.example'), created: true, linked: false, warnings: [] });

    const d = body(await api.get(`/api/nodes/${res.id}`), 200, nodeDetailResponseSchema);
    expect(d.node).toMatchObject({
      type: 'domain',
      value: 'target.example',
      label: 'Main target',
      confidence: 'discovered',
      sourceCount: 0,
      tag: 'interesting',
      notes: '**scope** note',
      posX: 12.5,
      posY: -4,
    });
    expect(d.observations).toEqual([
      expect.objectContaining({ tool: 'manual', command: 'added by analyst', role: 'finding', data: {}, jobId: null }),
    ]);
  });

  test('a child: the relation is filled in from the two types; the link counts no tool either', async () => {
    const api = await examples();
    const domain = idOf(api.db, 'example.com');
    const res = body(await add(api, { type: 'subdomain', value: 'new.example.com', parentId: domain }), 201, manualNodeResponseSchema);
    expect(res.linked).toBe(true);

    const d = body(await api.get(`/api/nodes/${res.id}`), 200, nodeDetailResponseSchema);
    expect(d.edges).toEqual([expect.objectContaining({ direction: 'in', relation: 'has_subdomain', sourceCount: 0, confidence: 'discovered' })]);
    const edge = body(await api.get(`/api/edges/${d.edges[0]?.id ?? ''}`), 200, edgeDetailResponseSchema);
    expect(edge.observations.map((o) => [o.tool, o.command])).toEqual([['manual', 'added by analyst']]);
    // The parent's own source_count doesn't change (it gets a parent row, which never counts anyway).
    const parent = body(await api.get(`/api/nodes/${domain}`), 200, nodeDetailResponseSchema);
    expect(parent.node.sourceCount).toBe(1);
  });

  test('severity, the validator warnings, and an out-of-scope value is accepted', async () => {
    const api = await examples();
    const url = idOf(api.db, 'https://api.example.com/');
    const vuln = body(
      await add(api, { type: 'vulnerability', value: 'cve-2024-0001', parentId: url, severity: 'high' }),
      201,
      manualNodeResponseSchema,
    );
    expect(vuln.warnings).toEqual([]);
    expect(body(await api.get(`/api/nodes/${vuln.id}`), 200, nodeDetailResponseSchema).node).toMatchObject({
      value: 'CVE-2024-0001',
      severity: 'high',
    });

    const bare = body(await add(api, { type: 'vulnerability', value: 'manual-check-1' }), 201, manualNodeResponseSchema);
    expect(bare.warnings).toEqual(['vulnerability has no severity', 'vulnerability has no parent; it will float alone on the graph']);

    // No scope rules at all: everything is out of scope, and that's fine for adding.
    const out = body(await add(api, { type: 'ip', value: '203.0.113.9' }), 201, manualNodeResponseSchema);
    expect(body(await api.get(`/api/nodes/${out.id}`), 200, nodeDetailResponseSchema).node.inScope).toBe('out');
  });

  test('broadcasts scan.ingested (tool manual) and graph.updated', async () => {
    const api = await testApi();
    const events: WsEvent[] = [];
    const socket = await api.app.injectWS('/api/ws', { headers: { host: HOST } });
    socket.on('message', (data: Buffer) => {
      events.push(wsEventSchema.parse(JSON.parse(data.toString())));
    });
    const res = body(await add(api, { type: 'domain', value: 'live.example' }), 201, manualNodeResponseSchema);
    await vi.waitFor(() => {
      expect(events).toContainEqual(expect.objectContaining({ type: 'scan.ingested', tool: 'manual' }));
      expect(events).toContainEqual({ type: 'graph.updated', nodeIds: [res.id], edgeIds: [] });
    });
    socket.terminate();
  });
});

describe('a value already in the graph', () => {
  test('200 with the existing node; nothing written (another spelling that normalizes the same counts too)', async () => {
    const api = await examples();
    const before = counts(api.db);
    const existing = idOf(api.db, '93.184.216.34');
    const res = body(await add(api, { type: 'ip', value: '::ffff:93.184.216.34', tag: 'ignored', notes: 'x' }), 200, manualNodeResponseSchema);
    expect(res).toEqual({ id: existing, created: false, linked: false, warnings: [] });
    expect(counts(api.db)).toEqual(before);
    expect(body(await api.get(`/api/nodes/${existing}`), 200, nodeDetailResponseSchema).node).toMatchObject({ tag: null, notes: '' });
  });

  test('ifExists: link adds only the parent link (once)', async () => {
    const api = await examples();
    const ip = idOf(api.db, '93.184.216.34');
    const other = body(await add(api, { type: 'subdomain', value: 'other.example.com' }), 201, manualNodeResponseSchema).id;

    const plain = body(await add(api, { type: 'ip', value: '93.184.216.34', parentId: other }), 200, manualNodeResponseSchema);
    expect(plain.linked).toBe(false);
    const linked = body(await add(api, { type: 'ip', value: '93.184.216.34', parentId: other, ifExists: 'link', severity: 'critical' }), 200, manualNodeResponseSchema);
    expect(linked).toEqual({ id: ip, created: false, linked: true, warnings: [] });

    const d = body(await api.get(`/api/nodes/${ip}`), 200, nodeDetailResponseSchema);
    expect(d.edges.filter((e) => e.direction === 'in').map((e) => e.other.value).sort()).toEqual(['api.example.com', 'other.example.com']);
    // The link is a manual sighting: no new corroboration, and the existing node's severity is untouched.
    expect(d.node).toMatchObject({ sourceCount: 1, severity: null });

    const again = body(await add(api, { type: 'ip', value: '93.184.216.34', parentId: other, ifExists: 'link' }), 200, manualNodeResponseSchema);
    expect(again.linked).toBe(false);
  });
});

describe('validation (422 in the validator wording)', () => {
  test.each([
    ['domain', 'Example.com', "value: domain value 'Example.com' must be lowercase"],
    ['subdomain', 'bücher.example.com', "value: subdomain value 'bücher.example.com' non-ASCII host: convert it to punycode, e.g. host.encode('idna').decode()"],
    ['subdomain', '*.example.com', 'wildcards like *.example.com are not allowed'],
    ['ip', '999.1.1.1', "value: ip value '999.1.1.1' is not a valid IPv4/IPv6 address"],
    ['port', '10.0.0.1:80', 'must look like ip:port/tcp, e.g. 93.184.216.34:443/tcp'],
    ['port', '10.0.0.1:70000/tcp', 'port number out of range'],
    ['url', 'ftp://example.com/', 'must be a full URL starting with http:// or https://'],
    ['certificate', 'AB:CD', 'must be a SHA-256 fingerprint'],
    ['domain', ' example.com', 'value has leading/trailing spaces'],
  ])('%s %j', async (type, value, message) => {
    const api = await testApi();
    error(await add(api, { type, value }), 422, message);
    expect(counts(api.db).scans).toBe(0);
  });

  test('parent problems', async () => {
    const api = await examples();
    const domain = idOf(api.db, 'example.com');
    const ip = idOf(api.db, '93.184.216.34');
    error(await add(api, { type: 'subdomain', value: 'x.example.com', parentId: '0000000000000000' }), 422, "parentId: node '0000000000000000' not found");
    error(await add(api, { type: 'port', value: '10.0.0.1:80/tcp', parentId: domain }), 422, "a port can't hang under a domain");
    error(
      await add(api, { type: 'ip', value: '10.0.0.1', parentId: ip, relation: 'has_port' }),
      422,
      "relation: 'has_port' can't link ip -> ip (allowed: ip -> port)",
    );
    error(await add(api, { type: 'domain', value: 'example.com', parentId: domain }), 422, 'its own parent');
  });

  test('bad request bodies are a 400', async () => {
    const api = await testApi();
    error(await add(api, { type: 'domain', value: 'a.example', x: 1 }), 400, 'give both x and y');
    error(await add(api, { type: 'domain', value: 'a.example', relation: 'has_subdomain' }), 400, "has 'relation' but no 'parentId'");
    error(await add(api, { type: 'planet', value: 'mars' }), 400);
    error(await add(api, { type: 'domain', value: 'a.example', extra: 1 }), 400);
  });
});

describe('corroboration and the reserved tool name', () => {
  test('a manual node stays discovered when one tool reports it, corroborated with two; verified is still possible', async () => {
    const api = await testApi();
    const { id } = body(await add(api, { type: 'domain', value: 'target.example' }), 201, manualNodeResponseSchema);
    const report = (tool: string, minute: string) =>
      ingestDocument(api.db, baseDoc({ tool, target: 'target.example', started_at: `2026-10-29T10:${minute}:00Z`, finished_at: `2026-10-29T10:${minute}:30Z`, findings: [{ type: 'domain', value: 'target.example' }] }));

    expect(report('alpha', '01').status).toBe('ingested');
    expect(body(await api.get(`/api/nodes/${id}`), 200, nodeDetailResponseSchema).node).toMatchObject({ sourceCount: 1, confidence: 'discovered' });
    expect(report('beta', '02').status).toBe('ingested');
    expect(body(await api.get(`/api/nodes/${id}`), 200, nodeDetailResponseSchema).node).toMatchObject({ sourceCount: 2, confidence: 'corroborated' });

    const other = body(await add(api, { type: 'domain', value: 'checked.example' }), 201, manualNodeResponseSchema).id;
    expect(body(await api.send('PATCH', `/api/nodes/${other}`, { confidence: 'verified' }), 200, nodeDetailResponseSchema).node).toMatchObject({
      confidence: 'verified',
      sourceCount: 0,
    });
  });

  test('POST /api/ingest and pnpm ingest refuse a file by tool "manual"', async () => {
    const api = await testApi();
    const doc = baseDoc({ tool: 'manual', findings: [{ type: 'domain', value: 'example.com' }] });
    error(await api.send('POST', '/api/ingest', doc), 422, "tool: 'manual' is reserved for nodes added by the analyst");
    expect(counts(api.db).scans).toBe(0);

    const dir = tempDir();
    const file = join(dir, 'manual.json');
    writeFileSync(file, JSON.stringify(doc));
    const err: string[] = [];
    const code = runIngestCli([file, '--db', join(dir, 'cli.db')], { out: () => undefined, err: (l) => err.push(l) }, {});
    expect(code).toBe(1);
    expect(err.join('\n')).toContain("tool: 'manual' is reserved for nodes added by the analyst");
  });
});
