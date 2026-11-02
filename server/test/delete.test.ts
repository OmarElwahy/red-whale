// planDeletion (server/src/graph/delete.ts): which nodes and edges an analyst delete removes. Pure.
import { describe, expect, test } from 'vitest';
import { planDeletion, type EdgeLink } from '../src/graph/delete';

/** `a>b` → an edge a → b with ID `a>b`. */
function links(...pairs: string[]): EdgeLink[] {
  return pairs.map((p) => {
    const [source = '', target = ''] = p.split('>');
    return { id: p, source, target };
  });
}

const sorted = (ids: string[]) => [...ids].sort();

describe('node mode', () => {
  test('removes the node and every edge touching it; children with no other parent become roots', () => {
    // domain → sub → ip ; domain → sub2 → ip (ip shared), sub → url
    const g = links('domain>sub', 'domain>sub2', 'sub>ip', 'sub2>ip', 'sub>url');
    const plan = planDeletion(g, ['sub'], 'node');
    expect(plan.nodeIds).toEqual(['sub']);
    expect(sorted(plan.edgeIds)).toEqual(['domain>sub', 'sub>ip', 'sub>url']);
    expect(plan.orphans).toBe(1); // url; ip still hangs under sub2
    expect(plan.keptShared).toBe(0);
  });

  test('several roots (a group, node only)', () => {
    const g = links('domain>a', 'domain>b', 'a>x', 'b>x');
    const plan = planDeletion(g, ['a', 'b'], 'node');
    expect(sorted(plan.nodeIds)).toEqual(['a', 'b']);
    expect(plan.orphans).toBe(1); // x lost both parents
  });
});

describe('subtree mode', () => {
  test('removes everything below, but keeps a shared node and everything below it', () => {
    const g = links('domain>sub', 'domain>sub2', 'sub>ip', 'sub2>ip', 'ip>port', 'sub>url', 'url>tech');
    const plan = planDeletion(g, ['sub'], 'subtree');
    expect(sorted(plan.nodeIds)).toEqual(['sub', 'tech', 'url']);
    expect(sorted(plan.edgeIds)).toEqual(['domain>sub', 'sub>ip', 'sub>url', 'url>tech']);
    expect(plan.keptShared).toBe(2); // ip and port
    expect(plan.orphans).toBe(0);
  });

  test('a cycle below the root goes too (url ⇄ url)', () => {
    const g = links('sub>u1', 'u1>u2', 'u2>u1');
    expect(sorted(planDeletion(g, ['sub'], 'subtree').nodeIds)).toEqual(['sub', 'u1', 'u2']);
  });

  test('a cycle that another node also reaches stays', () => {
    const g = links('sub>u1', 'u1>u2', 'u2>u1', 'other>u2');
    const plan = planDeletion(g, ['sub'], 'subtree');
    expect(plan.nodeIds).toEqual(['sub']);
    expect(plan.keptShared).toBe(2);
  });

  test('a node reached only through another root is removed, not kept by an edge from that root', () => {
    // Deleting a group {a, b}: x hangs under both members, y under x.
    const g = links('domain>a', 'domain>b', 'a>x', 'b>x', 'x>y');
    expect(sorted(planDeletion(g, ['a', 'b'], 'subtree').nodeIds)).toEqual(['a', 'b', 'x', 'y']);
  });

  test('the parent above the root is untouched', () => {
    const g = links('domain>sub', 'sub>ip');
    const plan = planDeletion(g, ['sub'], 'subtree');
    expect(sorted(plan.nodeIds)).toEqual(['ip', 'sub']);
    expect(plan.orphans).toBe(0);
  });
});
