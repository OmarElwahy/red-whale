import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CONFIDENCE_LEVELS,
  NODE_TYPES,
  SEVERITIES,
  SCOPE_DECISIONS,
  TAGS,
  exportResponseSchema,
  highlightsResponseSchema,
  ingestResponseSchema,
  scansResponseSchema,
  statsResponseSchema,
  validateContract,
} from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { EXAMPLES, INVALID_DIR, counts, exampleDoc, exampleText, jsonFiles } from '../helpers';
import { body, error, idOf, ingestExamples, isReal, openAll, testApi } from './helpers';

const zeros = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, 0]));

describe('GET /api/stats', () => {
  test('empty database: every key present, all zero', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/stats'), 200, statsResponseSchema)).toEqual({
      totals: { nodes: 0, edges: 0, scans: 0, observations: 0 },
      byType: zeros(NODE_TYPES),
      bySeverity: zeros([...SEVERITIES, 'none']),
      byConfidence: zeros(CONFIDENCE_LEVELS),
      byTag: zeros([...TAGS, 'none']),
      byScope: zeros(SCOPE_DECISIONS),
      byTool: {},
    });
  });

  test('after the examples, counts match the database', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const s = body(await api.get('/api/stats'), 200, statsResponseSchema);
    expect(s.totals).toEqual({ nodes: 11, edges: 11, scans: 4, observations: 15 });
    expect(Object.values(s.byType).reduce((a, b) => a + b, 0)).toBe(11);
    expect(s.byType).toMatchObject({ domain: 1, subdomain: 3, ip: 1, port: 2, url: 2, technology: 1, vulnerability: 1 });
    expect(s.bySeverity).toMatchObject({ medium: 1, none: 10 });
    expect(s.byConfidence.corroborated + s.byConfidence.discovered).toBe(11);
    expect(s.byTag.none).toBe(11);
    expect(Object.keys(s.byTool).sort()).toEqual(['httpx', 'nmap', 'nuclei', 'subfinder']);
    expect(s.byTool.nuclei).toBe(3);
  });
});

describe('GET /api/scans', () => {
  test('empty database', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/scans'), 200, scansResponseSchema)).toEqual({ scans: [] });
  });

  test('newest ingest first, with counts, without the raw file', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const { scans } = body(await api.get('/api/scans'), 200, scansResponseSchema);
    expect(scans.map((s) => s.tool)).toEqual([...EXAMPLES].reverse());
    for (const s of scans) {
      const file = exampleDoc(s.tool as (typeof EXAMPLES)[number]);
      expect(s.findingCount).toBe(file.findings.length);
      expect(s.command).toBe(file.command);
      expect(s).not.toHaveProperty('raw');
    }
    expect(scans.find((s) => s.tool === 'nmap')?.observationCount).toBe(5);
  });
});

describe('POST /api/ingest', () => {
  test('a valid file → 201, and its nodes appear in the graph', async () => {
    const api = await testApi();
    const res = await api.request({
      method: 'POST',
      url: '/api/ingest',
      payload: exampleText('nmap'),
      headers: { 'content-type': 'application/json' },
    });
    const r = body(res, 201, ingestResponseSchema);
    expect(r).toMatchObject({ status: 'ingested', created: { nodes: 5, edges: 4 }, observations: 5, warnings: [] });
    expect((await openAll(api)).nodes.filter(isReal)).toHaveLength(5);
  });

  test('the same file again → 200 duplicate, nothing changes', async () => {
    const api = await testApi();
    const first = body(await api.send('POST', '/api/ingest', exampleDoc('nmap')), 201, ingestResponseSchema);
    const before = counts(api.db);
    const again = body(await api.send('POST', '/api/ingest', exampleDoc('nmap')), 200, ingestResponseSchema);
    expect(again).toEqual({ status: 'duplicate', scanId: first.scanId, warnings: [] });
    expect(counts(api.db)).toEqual(before);
  });

  test.each(jsonFiles(INVALID_DIR))('invalid/%s → 422 with the validator errors, database untouched', async (file) => {
    const api = await testApi();
    ingestExamples(api.db);
    const before = counts(api.db);
    const doc: unknown = JSON.parse(readFileSync(join(INVALID_DIR, file), 'utf8'));
    const expected = validateContract(doc);
    if (expected.ok) throw new Error(`${file} should be invalid`);
    const res = await api.send('POST', '/api/ingest', doc);
    expect(error(res, 422, 'invalid tool-output file').issues).toEqual(expected.errors);
    expect(counts(api.db)).toEqual(before);
  });

  test('malformed JSON → 400', async () => {
    const api = await testApi();
    const res = await api.request({
      method: 'POST',
      url: '/api/ingest',
      payload: '{"tool": ',
      headers: { 'content-type': 'application/json' },
    });
    error(res, 400);
  });

  test('wrong content type → 415', async () => {
    const api = await testApi();
    const res = await api.request({
      method: 'POST',
      url: '/api/ingest',
      payload: exampleText('nmap'),
      headers: { 'content-type': 'text/plain' },
    });
    error(res, 415);
    expect(counts(api.db).scans).toBe(0);
  });

  test('a body over the limit → 413', async () => {
    const api = await testApi();
    const res = await api.request({
      method: 'POST',
      url: '/api/ingest',
      payload: JSON.stringify({ padding: 'x'.repeat(51 * 1024 * 1024) }),
      headers: { 'content-type': 'application/json' },
    });
    error(res, 413);
  });
});

describe('GET /api/highlights', () => {
  const tag = (api: Awaited<ReturnType<typeof testApi>>, label: string, patch: Record<string, unknown>) =>
    api.send('PATCH', `/api/nodes/${idOf(api.db, label)}`, patch);

  test('empty workspace, or nothing tagged: an empty list', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/highlights'), 200, highlightsResponseSchema)).toEqual({ items: [] });
    ingestExamples(api.db);
    expect(body(await api.get('/api/highlights'), 200, highlightsResponseSchema)).toEqual({ items: [] });
  });

  test('every interesting node with its notes, riskiest first; other tags are left out', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    await tag(api, 'api.example.com', { tag: 'interesting', notes: '## API\nCheck **auth**.' });
    await tag(api, 'dev.example.com', { tag: 'interesting' });
    await tag(api, 'example.com', { tag: 'checked', notes: 'done' });
    const r = body(await api.get('/api/highlights'), 200, highlightsResponseSchema);
    // dev.example.com has a medium finding below it; api.example.com has none.
    expect(r.items.map((n) => [n.label, n.notes, n.effectiveSeverity])).toEqual([
      ['dev.example.com', '', 'medium'],
      ['api.example.com', '## API\nCheck **auth**.', null],
    ]);
    expect(r.items.every((n) => n.tag === 'interesting')).toBe(true);
  });

  test('takes no filters: a filter param is a 400 rather than silently ignored', async () => {
    const api = await testApi();
    error(await api.get('/api/highlights?types=ip'), 400, 'types');
  });
});

describe('GET /api/export', () => {
  test('everything, as a download; counts match /api/stats', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const res = await api.get('/api/export?format=json');
    const e = body(res, 200, exportResponseSchema);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="redwhale-export-${e.exportedAt.slice(0, 19).replaceAll(':', '-')}Z.json"`,
    );
    // No colons in the name: Windows can't save them.
    expect(res.headers['content-disposition']).toMatch(/filename="redwhale-export-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.json"/);
    const { totals } = body(await api.get('/api/stats'), 200, statsResponseSchema);
    expect({ nodes: e.nodes.length, edges: e.edges.length, scans: e.scans.length, observations: e.observations.length }).toEqual(
      totals,
    );
    const nmapPort = e.nodes.find((n) => n.value === '93.184.216.34:443/tcp');
    expect(nmapPort?.data).toMatchObject({ product: 'nginx' });
  });

  test('json is the default format', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/export'), 200, exportResponseSchema).format).toBe('json');
  });

  test('other formats → 400 for now', async () => {
    const api = await testApi();
    error(await api.get('/api/export?format=csv'), 400, 'format');
  });
});
