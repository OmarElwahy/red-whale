import { takeoverWatchResponseSchema, type TakeoverWatchRow } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import type { Db } from '../src/db/client';
import { ingestDocument } from '../src/ingest/ingest';
import { addRule } from '../src/scope/store';
import { daysLeft, takeoverWatch, takeoverWatchRows } from '../src/takeover/watch';
import { body, testApi } from './api/helpers';
import { baseDoc, freshDb, type Doc } from './helpers';

const NOW = new Date('2026-12-01T12:00:00Z');
const OWN = 'northwind.example';
const FAR = '2028-01-01T00:00:00Z';

const sub = (name: string) => `${name}.${OWN}`;

function ingest(db: Db, doc: Doc) {
  const r = ingestDocument(db, doc, NOW);
  if (r.status !== 'ingested') throw new Error(JSON.stringify(r));
}

const reg = (value: string, data: Record<string, unknown>, parent?: { type: string; value: string }) => ({
  type: 'domain',
  value,
  ...(parent ? { parent, relation: 'cname_to' } : {}),
  data: { registered: true, expires_at: FAR, source: 'rdap', checked_at: '2026-11-30T00:00:00Z', ...data },
});
const hop = (value: string, from: string, data: Record<string, unknown> = {}) => ({
  type: 'subdomain',
  value,
  parent: { type: 'subdomain', value: from },
  relation: 'cname_to',
  data: { rcode: 'NOERROR', ...data },
});
const vuln = (id: string, target: string, severity: string) => ({
  type: 'vulnerability',
  value: id,
  parent: { type: 'subdomain', value: target },
  relation: 'has_vulnerability',
  severity,
  data: { reason: 'r' },
});

/** A takeover-check file for one subdomain, finishing at `at`. */
function check(target: string, findings: Record<string, unknown>[], at = '2026-11-30T10:00:00Z', status = 'success'): Doc {
  return baseDoc({
    tool: 'takeover-check',
    target,
    command: `takeover-check ${target} ${at}`,
    started_at: at,
    finished_at: at,
    status,
    errors: status === 'success' ? [] : ['an RDAP lookup timed out'],
    findings: [reg(OWN, {}), ...findings],
  });
}

function graph(db: Db, names: string[]) {
  ingest(
    db,
    baseDoc({
      tool: 'subfinder',
      target: OWN,
      findings: names.map((n) => ({ type: 'subdomain', value: n, parent: { type: 'domain', value: OWN }, relation: 'has_subdomain' })),
    }),
  );
}

function seed(db: Db) {
  graph(db, [sub('a'), sub('b'), sub('c'), sub('d'), sub('e'), sub('f'), sub('g'), sub('h'), 'out.other.example']);
  addRule(db, { kind: 'wildcard', value: `*.${OWN}`, action: 'include' });
  // a: takeable (CNAME to an unregistered domain).
  ingest(db, check(sub('a'), [reg('gone-7q2x.example', { registered: false, expires_at: null, reason: 'RDAP 404' }, { type: 'subdomain', value: sub('a') }), vuln('takeover-unregistered-domain', sub('a'), 'critical')]));
  // b: expiring in 20 days; c: already expired (still registered).
  ingest(db, check(sub('b'), [hop('b.cdn-x.example', sub('b')), reg('cdn-x.example', { expires_at: '2026-12-21T12:00:00Z' })]));
  ingest(db, check(sub('c'), [hop('c.old.example', sub('c')), reg('old.example', { expires_at: '2026-11-25T12:00:00Z' })]));
  // d: partial, one registration unknown.
  ingest(db, check(sub('d'), [hop('d.whois-x.example', sub('d')), reg('whois-x.example', { registered: null, expires_at: null, source: 'whois', reason: 'no expiry' })], undefined, 'partial'));
  // e: no CNAME, fine.
  ingest(db, check(sub('e'), []));
  // g: checked (fine), then excluded from scope.
  ingest(db, check(sub('g'), [hop('g.svc.azurewebsites.net', sub('g'), { service: 'azurewebsites.net' })]));
  addRule(db, { kind: 'domain', value: sub('g'), action: 'exclude' });
  // h: an older check through old-svc, the latest through new-svc.
  ingest(db, check(sub('h'), [hop('h.old-svc.example', sub('h')), reg('old-svc.example', {})], '2026-11-01T10:00:00Z'));
  ingest(db, check(sub('h'), [hop('h.new-svc.example', sub('h')), hop('h2.new-svc.example', 'h.new-svc.example'), reg('new-svc.example', {})]));
}

const row = (rows: TakeoverWatchRow[], name: string) => {
  const r = rows.find((x) => x.subdomain === name);
  if (!r) throw new Error(`no row ${name}`);
  return r;
};

describe('takeover watch rows', () => {
  test('status order: takeable, expiring (expired first, then soonest), unknown, ok, not checked, out of scope', () => {
    const db = freshDb();
    seed(db);
    const rows = takeoverWatchRows(db, NOW);
    expect(rows.map((r) => [r.subdomain, r.status])).toEqual([
      [sub('a'), 'takeable'],
      [sub('c'), 'expiring'],
      [sub('b'), 'expiring'],
      [sub('d'), 'unknown'],
      [sub('e'), 'ok'],
      [sub('g'), 'ok'],
      [sub('h'), 'ok'],
      [sub('f'), 'not-checked'],
      // Every subdomain is a row, the chain hops outside the scope too (never checked themselves).
      ['b.cdn-x.example', 'out-of-scope'],
      ['c.old.example', 'out-of-scope'],
      ['d.whois-x.example', 'out-of-scope'],
      ['g.svc.azurewebsites.net', 'out-of-scope'],
      ['h.new-svc.example', 'out-of-scope'],
      ['h.old-svc.example', 'out-of-scope'],
      ['h2.new-svc.example', 'out-of-scope'],
      ['out.other.example', 'out-of-scope'],
    ]);
  });

  test('a takeable row: its open vulnerability, the unregistered domain as the weakest link, every domain looked up', () => {
    const db = freshDb();
    seed(db);
    const a = row(takeoverWatchRows(db, NOW), sub('a'));
    expect(a.vulnerabilities.map(({ label, severity }) => ({ label, severity }))).toEqual([{ label: 'takeover-unregistered-domain', severity: 'critical' }]);
    expect(a.chain).toEqual(['gone-7q2x.example']);
    expect(a.chainEnd).toBe('gone-7q2x.example');
    expect(a.registration).toMatchObject({ domain: 'gone-7q2x.example', registered: false, reason: 'RDAP 404', daysLeft: null });
    expect(a.registrations.map((r) => r.domain)).toEqual(['gone-7q2x.example', OWN]);
    expect(a.lastCheck).toMatchObject({ at: '2026-11-30T10:00:00.000Z', status: 'success' });
  });

  test('days left, negative once expired; the weakest link is the expiring domain, not the own one', () => {
    const db = freshDb();
    seed(db);
    const rows = takeoverWatchRows(db, NOW);
    expect(row(rows, sub('b')).registration).toMatchObject({ domain: 'cdn-x.example', daysLeft: 20 });
    expect(row(rows, sub('c')).registration).toMatchObject({ domain: 'old.example', daysLeft: -6 });
    expect(daysLeft('not a date', NOW)).toBeNull();
    expect(daysLeft('2026-12-01T11:00:00Z', NOW)).toBe(-1);
  });

  test('the own domain expiring makes every row expiring, and it is the row’s registration', () => {
    const db = freshDb();
    graph(db, [sub('e')]);
    addRule(db, { kind: 'wildcard', value: `*.${OWN}`, action: 'include' });
    const doc = check(sub('e'), []);
    doc.findings = [reg(OWN, { expires_at: '2027-01-15T00:00:00Z' })];
    ingest(db, doc);
    const e = row(takeoverWatchRows(db, NOW), sub('e'));
    expect(e).toMatchObject({ status: 'expiring', chain: [], chainEnd: sub('e'), registration: { domain: OWN, daysLeft: 44 } });
  });

  test('unknown: partial scan or a registration nobody could read; the unknown one is the weakest link', () => {
    const db = freshDb();
    seed(db);
    const d = row(takeoverWatchRows(db, NOW), sub('d'));
    expect(d.registration).toMatchObject({ domain: 'whois-x.example', registered: null, reason: 'no expiry', source: 'whois' });
    expect(d.lastCheck?.status).toBe('partial');
  });

  test('within a status, the least time left first (rows without a date last), then by name', () => {
    const db = freshDb();
    graph(db, [sub('a'), sub('m'), sub('z'), sub('n')]);
    addRule(db, { kind: 'wildcard', value: `*.${OWN}`, action: 'include' });
    ingest(db, check(sub('a'), [])); // own domain only: FAR (~760 days)
    ingest(db, check(sub('m'), [])); // same date as a: by name
    ingest(db, check(sub('z'), [hop('z.svc-z.example', sub('z')), reg('svc-z.example', { expires_at: '2027-06-01T00:00:00Z' })]));
    ingest(db, check(sub('n'), [hop('n.svc-n.example', sub('n')), reg('svc-n.example', { expires_at: '2027-04-01T00:00:00Z' })]));
    const ok = takeoverWatchRows(db, NOW).filter((r) => r.status === 'ok');
    const far = daysLeft(FAR, NOW);
    expect(ok.map((r) => [r.subdomain, r.registration?.daysLeft])).toEqual([
      [sub('n'), daysLeft('2027-04-01T00:00:00Z', NOW)],
      [sub('z'), daysLeft('2027-06-01T00:00:00Z', NOW)],
      [sub('a'), far],
      [sub('m'), far],
    ]);
  });

  test('the chain comes from the latest scan only; a private suffix shows as the service', () => {
    const db = freshDb();
    seed(db);
    const rows = takeoverWatchRows(db, NOW);
    const h = row(rows, sub('h'));
    expect(h.chain).toEqual(['h.new-svc.example', 'h2.new-svc.example']);
    expect(h.chainEnd).toBe('h2.new-svc.example');
    expect(h.registrations.map((r) => r.domain)).toEqual(['new-svc.example', OWN]); // equally fine: by name
    const g = row(rows, sub('g'));
    expect(g).toMatchObject({ chainEnd: 'g.svc.azurewebsites.net', service: 'azurewebsites.net' });
  });

  test('out of scope: a checked subdomain keeps its last status (inScope false); a never-checked one is out-of-scope', () => {
    const db = freshDb();
    seed(db);
    const rows = takeoverWatchRows(db, NOW);
    expect(row(rows, sub('g'))).toMatchObject({ status: 'ok', inScope: false, lastCheck: { at: '2026-11-30T10:00:00.000Z' } });
    expect(row(rows, 'out.other.example')).toMatchObject({ status: 'out-of-scope', inScope: false, lastCheck: null, chainEnd: null });
    expect(row(rows, sub('f'))).toMatchObject({ status: 'not-checked', inScope: true });
  });

  test('a vulnerability tagged ignored is not open', () => {
    const db = freshDb();
    seed(db);
    db.$client.prepare("UPDATE nodes SET tag = 'ignored' WHERE type = 'vulnerability'").run();
    const a = row(takeoverWatchRows(db, NOW), sub('a'));
    expect(a.vulnerabilities).toEqual([]);
    expect(a.status).not.toBe('takeable');
  });

  test('a later check without the vulnerability closes it (the node stays, for provenance)', () => {
    const db = freshDb();
    seed(db);
    ingest(db, check(sub('a'), [], '2026-12-01T09:00:00Z'));
    const a = row(takeoverWatchRows(db, NOW), sub('a'));
    expect(a).toMatchObject({ status: 'ok', vulnerabilities: [], chain: [] });
    expect(db.$client.prepare("SELECT COUNT(*) AS n FROM nodes WHERE type = 'vulnerability'").get()).toEqual({ n: 1 });
  });

  test('the latest failed job shows as lastFailure; queued or running ones as pending', () => {
    const db = freshDb();
    seed(db);
    const ids = Object.fromEntries(
      db.$client.prepare<[], { id: string; value: string }>("SELECT id, value FROM nodes WHERE type = 'subdomain'").all().map((r) => [r.value, r.id]),
    );
    db.$client
      .prepare("INSERT INTO scope_log (source, target_type, target_value, mode, decision, reason, at) VALUES ('run', 'subdomain', 'x', 'passive', 'in', 'r', 'now')")
      .run();
    const job = db.$client.prepare(
      `INSERT INTO jobs (tool, tool_group, node_id, target_type, target_value, mode, status, trigger, queued_scope_log_id, timeout_sec, created_at, finished_at, error)
       VALUES ('takeover-check', 'dns', ?, 'subdomain', ?, 'passive', ?, 'auto', 1, 300, 'x', ?, ?)`,
    );
    job.run(ids[sub('f')], sub('f'), 'failed', '2026-12-01T08:00:00.000Z', 'the image is missing');
    job.run(ids[sub('e')], sub('e'), 'failed', '2026-11-29T08:00:00.000Z', 'old failure'); // before e's scan was ingested
    job.run(ids[sub('b')], sub('b'), 'queued', null, null);
    const rows = takeoverWatchRows(db, NOW);
    expect(row(rows, sub('f'))).toMatchObject({ status: 'not-checked', lastFailure: { at: '2026-12-01T08:00:00.000Z', error: 'the image is missing' } });
    expect(row(rows, sub('e')).lastFailure).toBeNull();
    expect(row(rows, sub('b')).pending).toBe(true);
    expect(row(rows, sub('a')).pending).toBe(false);
  });

  test('paging and counts', () => {
    const db = freshDb();
    seed(db);
    const page = takeoverWatch(db, { page: 2, pageSize: 4, now: NOW });
    expect(page.items.map((r) => r.subdomain)).toEqual([sub('e'), sub('g'), sub('h'), sub('f')]);
    expect(page).toMatchObject({ page: 2, pageSize: 4, total: 16, now: NOW.toISOString() });
    expect(page.counts).toEqual({ takeable: 1, expiring: 2, unknown: 1, ok: 3, 'not-checked': 1, 'out-of-scope': 8 });
  });
});

describe('GET /api/takeover/watch', () => {
  test('returns the rows, matching the schema; bad paging is a 400', async () => {
    const api = await testApi();
    seed(api.db);
    const res = body(await api.get('/api/takeover/watch?pageSize=3'), 200, takeoverWatchResponseSchema);
    expect(res.items).toHaveLength(3);
    expect(res.items[0]).toMatchObject({ subdomain: sub('a'), status: 'takeable' });
    expect(res.total).toBe(16);
    expect((await api.get('/api/takeover/watch?pageSize=9999')).statusCode).toBe(400);
  });

  test('an empty workspace has no rows', async () => {
    const api = await testApi();
    const res = body(await api.get('/api/takeover/watch'), 200, takeoverWatchResponseSchema);
    expect(res).toMatchObject({ items: [], total: 0, page: 1, pageSize: 100 });
  });
});
