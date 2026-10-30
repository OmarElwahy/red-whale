import { describe, expect, test } from 'vitest';
import { toElements } from '../src/graph/elements';
import { aggregate, edge, node } from './fixtures';

describe('toElements', () => {
  test('graph nodes: null severity becomes "none", the rest is carried over', () => {
    const [el] = toElements({ nodes: [node('a', { effectiveSeverity: 'medium', tag: 'checked' })], edges: [] });
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
      },
    });
  });

  test('a saved position becomes the element position; half a position is ignored', () => {
    const els = toElements({ nodes: [node('a', { posX: 1, posY: 2 }), node('b', { posX: 1 })], edges: [] });
    expect(els[0]).toMatchObject({ position: { x: 1, y: 2 } });
    expect(els[1]).not.toHaveProperty('position');
  });

  test('aggregates take the member type and max severity, with the count on its own line', () => {
    const [el] = toElements({ nodes: [aggregate()], edges: [] });
    expect(el).toEqual({
      group: 'nodes',
      data: {
        id: 'agg:0123456789abcdef:has_subdomain:subdomain',
        kind: 'aggregate',
        type: 'subdomain',
        label: '412\nsubdomains',
        severity: 'high',
        count: 412,
        total: 420,
        relation: 'has_subdomain',
        parentId: '0123456789abcdef',
      },
    });
  });

  test('root aggregates and aggregates without a severity', () => {
    const [el] = toElements({
      nodes: [aggregate({ id: 'agg:root:ip', childType: 'ip', relation: null, parentId: null, maxSeverity: null, label: '30 IPs' })],
      edges: [],
    });
    expect(el?.data).toMatchObject({ type: 'ip', severity: 'none', relation: null, parentId: null, label: '30\nIPs' });
  });

  test('edges', () => {
    const els = toElements({ nodes: [], edges: [edge('a', 'b', { relation: 'resolves_to' })] });
    expect(els).toEqual([{ group: 'edges', data: { id: 'a->b', source: 'a', target: 'b', relation: 'resolves_to' } }]);
  });
});
