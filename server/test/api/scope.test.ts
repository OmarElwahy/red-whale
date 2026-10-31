import {
  graphResponseSchema,
  nodeDetailResponseSchema,
  nodeListResponseSchema,
  scopeCheckResponseSchema,
  scopeLogResponseSchema,
  scopeRuleSchema,
  scopeRulesResponseSchema,
  scopeSettingsSchema,
  statsResponseSchema,
  wsEventSchema,
  type WsEvent,
} from '@redwhale/shared';
import { describe, expect, test, vi } from 'vitest';
import { exampleDoc } from '../helpers';
import { HOST, body, error, idOf, ingestExamples, testApi, type TestApi } from './helpers';

async function addRule(api: TestApi, rule: Record<string, unknown>) {
  return body(await api.send('POST', '/api/scope/rules', rule), 201, scopeRuleSchema);
}

/** The examples' graph (example.com, api/dev/mail subdomains, 93.184.216.34 and its ports) with a scope. */
async function scopedExamples() {
  const api = await testApi();
  ingestExamples(api.db);
  const apex = await addRule(api, { kind: 'domain', value: 'example.com', action: 'include' });
  const wild = await addRule(api, { kind: 'wildcard', value: '*.example.com', action: 'include', note: 'from the SOW' });
  const dev = await addRule(api, { kind: 'domain', value: 'dev.example.com', action: 'exclude' });
  return { api, apex, wild, dev };
}

describe('scope rules', () => {
  test('POST normalizes the value and returns the stored rule', async () => {
    const api = await testApi();
    const rule = await addRule(api, { kind: 'wildcard', value: '*.Bücher.Example.', action: 'include' });
    expect(rule).toMatchObject({ id: 1, kind: 'wildcard', value: '*.xn--bcher-kva.example', action: 'include', note: '', removedAt: null });
    expect(body(await api.get('/api/scope/rules'), 200, scopeRulesResponseSchema).rules).toEqual([rule]);
  });

  test.each([
    [{ kind: 'wildcard', value: '*.com', action: 'include' }, /com is a public suffix/],
    [{ kind: 'wildcard', value: '*.co.uk', action: 'include' }, /co\.uk is a public suffix/],
    [{ kind: 'wildcard', value: '*.com.eg', action: 'include' }, /com\.eg is a public suffix/],
    [{ kind: 'cidr', value: '0.0.0.0/0', action: 'include' }, /too broad.*narrower include rules/],
    [{ kind: 'cidr', value: '::/0', action: 'include' }, /too broad/],
    [{ kind: 'cidr', value: '10.0.0.0/7', action: 'include' }, /at most \/8/],
    [{ kind: 'cidr', value: '10.0.0.1/8', action: 'include' }, /did you mean 10\.0\.0\.0\/8/],
    [{ kind: 'domain', value: 'not a host', action: 'include' }, /not a hostname/],
  ])('a refused rule is a 400 that says why: %j', async (rule, message) => {
    const api = await testApi();
    error(await api.send('POST', '/api/scope/rules', rule), 400, message);
    expect(body(await api.get('/api/scope/rules'), 200, scopeRulesResponseSchema).rules).toEqual([]);
  });

  test('excludes may be any size', async () => {
    const api = await testApi();
    await addRule(api, { kind: 'cidr', value: '0.0.0.0/0', action: 'exclude' });
    await addRule(api, { kind: 'wildcard', value: '*.com', action: 'exclude' });
  });

  test('bad bodies are a 400', async () => {
    const api = await testApi();
    error(await api.send('POST', '/api/scope/rules', { kind: 'regex', value: '.*', action: 'include' }), 400);
    error(await api.send('POST', '/api/scope/rules', { kind: 'domain', value: 'a.com', action: 'include', id: 7 }), 400);
  });

  test('an active twin is a 409 (after normalization); once removed it can be added again', async () => {
    const api = await testApi();
    const first = await addRule(api, { kind: 'domain', value: 'example.com', action: 'include' });
    error(await api.send('POST', '/api/scope/rules', { kind: 'domain', value: 'EXAMPLE.com.', action: 'include' }), 409, `rule #${String(first.id)}`);
    // The same value as an exclude is a different rule.
    await addRule(api, { kind: 'domain', value: 'example.com', action: 'exclude' });
    await api.send('PATCH', `/api/scope/rules/${String(first.id)}`, { removed: true });
    const again = await addRule(api, { kind: 'domain', value: 'example.com', action: 'include' });
    expect(again.id).not.toBe(first.id);
  });

  test('PATCH edits the note and soft-deletes: the row stays, only the active list loses it', async () => {
    const api = await testApi();
    const rule = await addRule(api, { kind: 'ip', value: '203.0.113.7', action: 'include' });
    const noted = body(await api.send('PATCH', `/api/scope/rules/${String(rule.id)}`, { note: 'VPN gateway' }), 200, scopeRuleSchema);
    expect(noted.note).toBe('VPN gateway');

    const removed = body(await api.send('PATCH', `/api/scope/rules/${String(rule.id)}`, { removed: true }), 200, scopeRuleSchema);
    expect(removed.removedAt).not.toBeNull();
    expect(body(await api.get('/api/scope/rules'), 200, scopeRulesResponseSchema).rules).toEqual([]);
    expect(body(await api.get('/api/scope/rules?removed=1'), 200, scopeRulesResponseSchema).rules).toEqual([removed]);
    expect(api.db.$client.prepare('SELECT COUNT(*) AS n FROM scope_rules').get()).toEqual({ n: 1 });

    error(await api.send('PATCH', `/api/scope/rules/${String(rule.id)}`, { removed: true }), 409, 'already removed');
  });

  test('PATCH can not change kind/value/action, restore, or be empty; unknown IDs are 404', async () => {
    const api = await testApi();
    const rule = await addRule(api, { kind: 'ip', value: '203.0.113.7', action: 'include' });
    const url = `/api/scope/rules/${String(rule.id)}`;
    error(await api.send('PATCH', url, { value: '203.0.113.8' }), 400);
    error(await api.send('PATCH', url, { removed: false }), 400);
    error(await api.send('PATCH', url, {}), 400, 'nothing to update');
    error(await api.send('PATCH', '/api/scope/rules/99', { note: 'x' }), 404);
    error(await api.send('PATCH', '/api/scope/rules/abc', { note: 'x' }), 400);
  });
});

describe('scope settings', () => {
  test('passive-only is on by default and can be turned off', async () => {
    const api = await testApi();
    expect(body(await api.get('/api/scope/settings'), 200, scopeSettingsSchema).passiveOnly).toBe(true);
    const off = body(await api.send('PATCH', '/api/scope/settings', { passiveOnly: false }), 200, scopeSettingsSchema);
    expect(off.passiveOnly).toBe(false);
    expect(body(await api.get('/api/scope/settings'), 200, scopeSettingsSchema)).toEqual(off);
    error(await api.send('PATCH', '/api/scope/settings', { passiveOnly: 'no' }), 400);
  });
});

describe('scope check', () => {
  test('GET answers without logging', async () => {
    const { api, wild } = await scopedExamples();
    const r = body(await api.get('/api/scope/check?type=subdomain&value=www.example.com'), 200, scopeCheckResponseSchema);
    expect(r).toMatchObject({ type: 'subdomain', value: 'www.example.com', mode: 'passive', decision: 'in', rule: { id: wild.id, note: 'from the SOW' }, logId: null });
    const log = body(await api.get('/api/scope/log?source=check,run'), 200, scopeLogResponseSchema);
    expect(log.total).toBe(0);
  });

  test('POST answers the same and logs it as a check', async () => {
    const { api, dev } = await scopedExamples();
    const r = body(await api.send('POST', '/api/scope/check', { type: 'subdomain', value: 'dev.example.com', mode: 'active' }), 200, scopeCheckResponseSchema);
    expect(r).toMatchObject({ decision: 'out', rule: { id: dev.id }, mode: 'active' });
    expect(r.logId).toEqual(expect.any(Number));

    // The log shows runs by default; checks only when asked for.
    expect(body(await api.get('/api/scope/log'), 200, scopeLogResponseSchema).total).toBe(0);
    const log = body(await api.get('/api/scope/log?source=run,check'), 200, scopeLogResponseSchema);
    expect(log.items).toEqual([
      expect.objectContaining({ id: r.logId, source: 'check', targetType: 'subdomain', targetValue: 'dev.example.com', decision: 'out', rule: expect.objectContaining({ id: dev.id }) as unknown }),
    ]);
  });

  test('passive-only applies to active checks', async () => {
    const { api } = await scopedExamples();
    const active = body(await api.get('/api/scope/check?type=subdomain&value=api.example.com&mode=active'), 200, scopeCheckResponseSchema);
    expect(active).toMatchObject({ decision: 'out', rule: null, reason: expect.stringMatching(/passive-only/) as unknown });
  });

  test('bad input is a 400; an unparseable value is a clean "out"', async () => {
    const { api } = await scopedExamples();
    error(await api.get('/api/scope/check?type=planet&value=x'), 400);
    error(await api.get('/api/scope/check?type=ip'), 400);
    error(await api.get('/api/scope/check?type=ip&value=1.2.3.4&mode=loud'), 400);
    const r = body(await api.get('/api/scope/check?type=ip&value=1.2.3'), 200, scopeCheckResponseSchema);
    expect(r).toMatchObject({ decision: 'out', reason: expect.stringMatching(/invalid ip/) as unknown });
  });

  test('a GET from another web page (no Origin, e.g. an <img>) can not write the log; a foreign Origin is refused', async () => {
    const { api } = await scopedExamples();
    await api.app.inject({ method: 'GET', url: '/api/scope/check?type=ip&value=1.2.3.4', headers: { host: HOST } });
    expect(api.db.$client.prepare('SELECT COUNT(*) AS n FROM scope_log').get()).toEqual({ n: 0 });
    const foreign = await api.request({ method: 'POST', url: '/api/scope/check', payload: { type: 'ip', value: '1.2.3.4' }, headers: { origin: 'https://evil.test' } });
    error(foreign, 403, 'is not allowed');
    expect(api.db.$client.prepare('SELECT COUNT(*) AS n FROM scope_log').get()).toEqual({ n: 0 });
  });
});

describe('scope log', () => {
  test('newest first, paged, and a removed rule is still named', async () => {
    const { api, wild } = await scopedExamples();
    for (const value of ['a.example.com', 'b.example.com', 'c.example.com']) {
      await api.send('POST', '/api/scope/check', { type: 'subdomain', value });
    }
    await api.send('PATCH', `/api/scope/rules/${String(wild.id)}`, { removed: true });
    const p1 = body(await api.get('/api/scope/log?source=check&pageSize=2'), 200, scopeLogResponseSchema);
    expect(p1).toMatchObject({ page: 1, pageSize: 2, total: 3 });
    expect(p1.items.map((e) => e.targetValue)).toEqual(['c.example.com', 'b.example.com']);
    expect(p1.items[0]?.rule).toMatchObject({ id: wild.id, removedAt: expect.any(String) as unknown });
    const p2 = body(await api.get('/api/scope/log?source=check&pageSize=2&page=2'), 200, scopeLogResponseSchema);
    expect(p2.items.map((e) => e.targetValue)).toEqual(['a.example.com']);
    error(await api.get('/api/scope/log?pageSize=201'), 400);
    error(await api.get('/api/scope/log?source=audit'), 400);
  });
});

describe('inScope on the graph', () => {
  test('every node carries its passive decision; the IP a subdomain resolves to stays out', async () => {
    const { api } = await scopedExamples();
    const graph = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const byValue = Object.fromEntries(graph.nodes.flatMap((n) => (n.type === 'aggregate' ? [] : [[n.value, n.inScope]])));
    expect(byValue).toEqual({
      'example.com': 'in',
      'api.example.com': 'in',
      'mail.example.com': 'in',
      'dev.example.com': 'out',
      '93.184.216.34': 'out',
      '93.184.216.34:22/tcp': 'out',
      '93.184.216.34:443/tcp': 'out',
      'https://api.example.com/': 'in',
      'https://dev.example.com/.git/config': 'out',
      'nginx/1.18.0': 'n/a',
      'git-config-exposure': 'n/a',
    });
  });

  test('with an empty scope everything targetable is out', async () => {
    const api = await testApi();
    ingestExamples(api.db);
    const graph = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const decisions = new Set(graph.nodes.flatMap((n) => (n.type === 'aggregate' ? [] : [n.inScope])));
    expect(decisions).toEqual(new Set(['out', 'n/a']));
  });

  test('a rule change applies to the next read (nothing is stored)', async () => {
    const { api } = await scopedExamples();
    await addRule(api, { kind: 'cidr', value: '93.184.216.0/24', action: 'include' });
    const graph = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const ip = graph.nodes.find((n) => n.type === 'ip');
    expect(ip && ip.type !== 'aggregate' && ip.inScope).toBe('in');
  });

  test('scope= filters /graph, /graph/expand and /nodes; /stats counts byScope', async () => {
    const { api } = await scopedExamples();
    const out = body(await api.get('/api/graph?scope=out'), 200, graphResponseSchema);
    expect(out.nodes.map((n) => (n.type === 'aggregate' ? n.id : n.value)).sort()).toEqual(
      ['93.184.216.34', '93.184.216.34:22/tcp', '93.184.216.34:443/tcp', 'dev.example.com', 'https://dev.example.com/.git/config'].sort(),
    );
    const list = body(await api.get('/api/nodes?scope=in,n/a'), 200, nodeListResponseSchema);
    expect(list.total).toBe(6);
    expect(new Set(list.items.map((n) => n.inScope))).toEqual(new Set(['in', 'n/a']));

    // The in-scope apex is filtered out, so dev.example.com is parentless here (§7: agg:root:<type>).
    const expand = await api.get('/api/graph/expand/agg:root:subdomain?scope=out');
    expect(expand.statusCode).toBe(200);
    expect(expand.json<{ nodes: { value: string }[] }>().nodes.map((n) => n.value)).toEqual(['dev.example.com']);
    const apexId = idOf(api.db, 'example.com');
    const members = await api.get(`/api/graph/expand/agg:${apexId}:has_subdomain:subdomain?scope=in`);
    expect(members.json<{ nodes: { value: string }[] }>().nodes.map((n) => n.value)).toEqual(['api.example.com', 'mail.example.com']);

    error(await api.get('/api/graph?scope=maybe'), 400);

    const stats = body(await api.get('/api/stats'), 200, statsResponseSchema);
    expect(stats.byScope).toEqual({ in: 4, out: 5, 'n/a': 2 });
  });

  test('node detail shows the decision and the rule', async () => {
    const { api, dev } = await scopedExamples();
    const detail = body(await api.get(`/api/nodes/${idOf(api.db, 'dev.example.com')}`), 200, nodeDetailResponseSchema);
    expect(detail.node.inScope).toBe('out');
    expect(detail.scope).toMatchObject({ decision: 'out', rule: { id: dev.id, kind: 'domain', action: 'exclude' } });
    const ip = body(await api.get(`/api/nodes/${idOf(api.db, '93.184.216.34')}`), 200, nodeDetailResponseSchema);
    expect(ip.scope).toMatchObject({ decision: 'out', rule: null, reason: expect.stringMatching(/domain rules never cover IP/) as unknown });
  });

  test('ingest never rejects out-of-scope findings', async () => {
    const api = await testApi();
    await addRule(api, { kind: 'domain', value: 'other.example', action: 'include' });
    expect((await api.send('POST', '/api/ingest', exampleDoc('nmap'))).statusCode).toBe(201);
  });
});

describe('scope.changed', () => {
  test('adding, editing and removing rules and changing settings each broadcast it; checks do not', async () => {
    const api = await testApi();
    const events: WsEvent[] = [];
    const socket = await api.app.injectWS('/api/ws', { headers: { host: HOST } });
    socket.on('message', (data: Buffer) => {
      events.push(wsEventSchema.parse(JSON.parse(data.toString())));
    });
    const rule = await addRule(api, { kind: 'domain', value: 'example.com', action: 'include' });
    await api.send('PATCH', `/api/scope/rules/${String(rule.id)}`, { note: 'x' });
    await api.send('PATCH', `/api/scope/rules/${String(rule.id)}`, { removed: true });
    await api.send('PATCH', '/api/scope/settings', { passiveOnly: false });
    await api.send('POST', '/api/scope/check', { type: 'domain', value: 'example.com' });
    await vi.waitFor(() => {
      expect(events).toHaveLength(4);
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual(Array.from({ length: 4 }, () => ({ type: 'scope.changed' })));
    socket.terminate();
  });

  test('a refused rule broadcasts nothing', async () => {
    const api = await testApi();
    const events: unknown[] = [];
    const socket = await api.app.injectWS('/api/ws', { headers: { host: HOST } });
    socket.on('message', (data: Buffer) => {
      events.push(JSON.parse(data.toString()));
    });
    await api.send('POST', '/api/scope/rules', { kind: 'wildcard', value: '*.com', action: 'include' });
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toEqual([]);
    socket.terminate();
  });
});
