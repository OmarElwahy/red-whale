import { edgeId, nodeId } from '@redwhale/shared';
import { expect, test } from 'vitest';
import { planIngest, type IngestPlan } from '../src/ingest/plan';
import { baseDoc, exampleDoc, validated } from './helpers';

function plan(doc: unknown): IngestPlan {
  const result = planIngest(validated(doc));
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.plan;
}

function sizes(p: IngestPlan) {
  return { nodes: p.nodes.size, edges: p.edges.size, observations: p.observations.size };
}

test('subfinder example: 4 nodes, 3 edges, 4 observations', () => {
  expect(sizes(plan(exampleDoc('subfinder')))).toEqual({ nodes: 4, edges: 3, observations: 4 });
});

test('nmap example: 5 nodes, 4 edges, 5 observations; parent-only nodes are observed with {}', () => {
  const p = plan(exampleDoc('nmap'));
  expect(sizes(p)).toEqual({ nodes: 5, edges: 4, observations: 5 });

  // api.example.com only appears as a parent.
  expect(p.observations.get(nodeId('subdomain', 'api.example.com'))).toEqual({
    nodeId: nodeId('subdomain', 'api.example.com'),
    severity: null,
    data: {},
  });
  // Port 443 is both a finding and a parent: one observation carrying the finding's data.
  expect(p.observations.get(nodeId('port', '93.184.216.34:443/tcp'))?.data).toEqual({
    state: 'open',
    service: 'https',
    product: 'nginx',
    version: '1.18.0',
  });
});

test('edges point parent → child with the shared edge ID', () => {
  const p = plan(exampleDoc('subfinder'));
  const domain = nodeId('domain', 'example.com');
  const api = nodeId('subdomain', 'api.example.com');
  const id = edgeId(domain, 'has_subdomain', api);
  expect(p.edges.get(id)).toEqual({ id, sourceId: domain, targetId: api, relation: 'has_subdomain' });
});

test('a node found twice in one file: one node, one merged observation, one edge per parent', () => {
  const doc = baseDoc({
    findings: [
      {
        type: 'technology',
        value: 'Nginx/1.18.0',
        parent: { type: 'url', value: 'https://a.example.com/' },
        relation: 'uses_technology',
        data: { a: 1, shared: 'first' },
      },
      {
        type: 'technology',
        value: 'nginx/1.18.0',
        parent: { type: 'url', value: 'https://b.example.com/' },
        relation: 'uses_technology',
        data: { b: 2, shared: 'second' },
      },
      {
        type: 'vulnerability',
        value: 'CVE-2021-23017',
        parent: { type: 'technology', value: 'nginx/1.18.0' },
        relation: 'has_vulnerability',
        severity: 'high',
      },
      {
        type: 'vulnerability',
        value: 'cve-2021-23017',
        parent: { type: 'technology', value: 'nginx/1.18.0' },
        relation: 'has_vulnerability',
        severity: 'low',
      },
    ],
  });
  const p = plan(doc);
  expect(sizes(p)).toEqual({ nodes: 4, edges: 3, observations: 4 });

  const tech = nodeId('technology', 'nginx/1.18.0');
  expect(p.nodes.get(tech)?.label).toBe('Nginx/1.18.0'); // first spelling wins
  expect(p.observations.get(tech)?.data).toEqual({ a: 1, b: 2, shared: 'second' });
  expect(p.observations.get(nodeId('vulnerability', 'CVE-2021-23017'))?.severity).toBe('high');
});

test('a value that passes validation but cannot be normalized rejects the file with its path', () => {
  const doc = baseDoc({
    findings: [
      { type: 'domain', value: 'example.com' },
      {
        type: 'url',
        value: 'https://bad host.example.com/',
        parent: { type: 'domain', value: 'example.com' },
        relation: 'serves',
      },
      {
        type: 'technology',
        value: 'php',
        parent: { type: 'url', value: 'https://bad host.example.com/x' },
        relation: 'uses_technology',
      },
    ],
  });
  const result = planIngest(validated(doc));
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.errors).toEqual([
    expect.stringMatching(/^findings\[1\]\.value: not a URL/),
    expect.stringMatching(/^findings\[2\]\.parent\.value: not a URL/),
  ]);
});
