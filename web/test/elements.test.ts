import { describe, expect, test } from 'vitest';
import { toElements } from '../src/graph/elements';
import { aggregate, edge, node, more } from './fixtures';

describe('toElements', () => {
  test('graph nodes: null severity becomes "none", the rest is carried over', () => {
    const [el] = toElements({ nodes: [node('a', { effectiveSeverity: 'medium', tag: 'checked', inScope: 'out' })], edges: [] });
    expect(el).toEqual({
      group: 'nodes',
      data: {
        id: 'a',
        kind: 'node',
        type: 'subdomain',
        value: 'a.example.com',
        label: 'a.example.com',
        severity: 'none',
        effectiveSeverity: 'medium',
        confidence: 'discovered',
        sourceCount: 1,
        tag: 'checked',
        inScope: 'out',
      },
    });
  });

  test('a saved position becomes the element position; half a position is ignored', () => {
    const els = toElements({ nodes: [node('a', { posX: 1, posY: 2 }), node('b', { posX: 1 })], edges: [] });
    expect(els[0]).toMatchObject({ position: { x: 1, y: 2 } });
    expect(els[1]).not.toHaveProperty('position');
  });

  test('groups take the member type and max severity, with their state and risk', () => {
    const [el] = toElements({ nodes: [aggregate({ risk: { critical: 2, high: 1 } })], edges: [] });
    expect(el).toEqual({
      group: 'nodes',
      data: {
        id: 'agg:0123456789abcdef:has_subdomain:subdomain',
        kind: 'aggregate',
        type: 'subdomain',
        label: '412 subdomains',
        severity: 'high',
        count: 412,
        relation: 'has_subdomain',
        parentId: '0123456789abcdef',
        expanded: false,
        shown: 0,
        remaining: 412,
        canLoadMore: true,
        risk: 3,
        riskWorst: 'critical',
        riskTitle: '2 critical, 1 high below',
      },
    });
  });

  test('"more" nodes', () => {
    const [el] = toElements({ nodes: [more('agg:root:ip', 150)], edges: [] });
    expect(el?.data).toEqual({ id: 'more:agg:root:ip', kind: 'more', groupId: 'agg:root:ip', label: '+150 more', remaining: 150 });
  });

  test('root aggregates and aggregates without a severity', () => {
    const [el] = toElements({
      nodes: [aggregate({ id: 'agg:root:ip', childType: 'ip', relation: null, parentId: null, maxSeverity: null, label: '30 IPs' })],
      edges: [],
    });
    expect(el?.data).toMatchObject({ type: 'ip', severity: 'none', relation: null, parentId: null, label: '30 IPs', riskWorst: 'none' });
  });

  test('edges carry their kind; only real and parent → group edges are labelled with the relation', () => {
    const els = toElements({
      nodes: [],
      edges: [
        edge('a', 'b', { relation: 'resolves_to' }),
        edge('a', 'g', { kind: 'group' }),
        edge('g', 'm', { kind: 'member', relation: null }),
      ],
    });
    expect(els.map((e) => e.data)).toEqual([
      { id: 'a->b', source: 'a', target: 'b', relation: 'resolves_to', kind: 'relation', label: 'resolves_to' },
      { id: 'a->g', source: 'a', target: 'g', relation: 'has_subdomain', kind: 'group', label: 'has_subdomain' },
      { id: 'g->m', source: 'g', target: 'm', relation: null, kind: 'member', label: '' },
    ]);
  });
});
