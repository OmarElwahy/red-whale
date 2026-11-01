// `pnpm mock`: the small showcase. Its job is to show every kind of thing the UI can draw, so these tests
// read the shared enums: when an enum grows, the showcase must grow with it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CONFIDENCE_LEVELS,
  EDGE_CONFIDENCE_LEVELS,
  NODE_TYPES,
  RELATION_TYPES,
  SCOPE_ACTIONS,
  SCOPE_DECISIONS,
  SCOPE_KINDS,
  SEVERITIES,
  TAGS,
  graphPathResponseSchema,
  graphResponseSchema,
  nodeId,
  validateContract,
} from '@redwhale/shared';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openDb, type Db } from '../src/db/client';
import { foreignScans, isMockTarget, runMockCli, wipeWorkspace, type MockKind } from '../src/mock/cli';
import { mockFileText } from '../src/mock/generate';
import { findPython } from '../src/mock/python';
import { SHOWCASE_DOMAIN, SHOWCASE_SCOPE, generateShowcase } from '../src/mock/showcase';
import { compileScope } from '@redwhale/shared';
import { currentScope, getSettings, listRules } from '../src/scope/store';
import { body, testApi } from './api/helpers';
import { counts, exampleText, tempDir } from './helpers';
import { ingestText } from '../src/ingest/ingest';

function run(kind: MockKind, argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runMockCli(kind, argv, { out: (l) => out.push(l), err: (l) => err.push(l) }, {});
  return { code, out, err };
}

function all<T>(db: Db, sql: string): T[] {
  return db.$client.prepare(sql).all() as T[];
}
const column = (db: Db, sql: string) => all<{ v: string | null }>(db, sql).map((r) => r.v);

/** Runs `pnpm mock` into a fresh database in `dir` and returns it, open. */
function showcaseDb(dir: string = tempDir()): Db {
  const path = join(dir, 'showcase.db');
  const result = run('showcase', ['--out', join(dir, 'out'), '--db', path, '--skip-python']);
  expect(result.code, result.err.join('\n')).toBe(0);
  return openDb(path);
}

describe('showcase generator', () => {
  test('every file is clean under Zod and deterministic', () => {
    const files = generateShowcase();
    expect(files.map(mockFileText)).toEqual(generateShowcase().map(mockFileText));
    for (const f of files) {
      const result = validateContract(JSON.parse(mockFileText(f)));
      expect(result.ok ? result.warnings : result.errors, f.tool).toEqual([]);
      expect(isMockTarget(f.doc.target), f.tool).toBe(true);
    }
  });

  test.skipIf(!findPython())('tools/validate_output.py accepts every file', () => {
    const result = run('showcase', ['--out', tempDir(), '--no-ingest']);
    expect(result.code, result.err.join('\n')).toBe(0);
    expect(result.out).toContain('tools/validate_output.py: all files pass');
  });
});

describe('after pnpm mock', () => {
  // One database for the whole block, in a directory of its own: tempDir() is removed after every test.
  const dir = mkdtempSync(join(tmpdir(), 'redwhale-showcase-'));
  let db: Db;
  beforeAll(() => {
    db = showcaseDb(dir);
  });
  afterAll(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('small enough to read: 40 to 80 nodes', () => {
    const [row] = all<{ n: number }>(db, 'SELECT COUNT(*) AS n FROM nodes');
    expect(row?.n).toBeGreaterThanOrEqual(40);
    expect(row?.n).toBeLessThanOrEqual(80);
  });

  test('covers every node type', () => {
    expect(new Set(column(db, 'SELECT DISTINCT type AS v FROM nodes'))).toEqual(new Set(NODE_TYPES));
  });

  test('covers every relation', () => {
    expect(new Set(column(db, 'SELECT DISTINCT relation AS v FROM edges'))).toEqual(new Set(RELATION_TYPES));
  });

  test('covers every severity, and nodes with none', () => {
    expect(new Set(column(db, 'SELECT DISTINCT severity AS v FROM nodes'))).toEqual(new Set([null, ...SEVERITIES]));
  });

  test('covers every confidence: discovered, corroborated by 2+ tools, verified', () => {
    expect(new Set(column(db, 'SELECT DISTINCT confidence AS v FROM nodes'))).toEqual(new Set(CONFIDENCE_LEVELS));
    const corroborated = all<{ source_count: number }>(
      db,
      "SELECT source_count FROM nodes WHERE confidence = 'corroborated'",
    );
    for (const r of corroborated) expect(r.source_count).toBeGreaterThanOrEqual(2);
  });

  test('covers every edge confidence: an edge from 2+ tools (corroborated) and one from a single tool', () => {
    expect(new Set(column(db, 'SELECT DISTINCT confidence AS v FROM edges'))).toEqual(new Set(EDGE_CONFIDENCE_LEVELS));
    const rows = all<{ confidence: string; source_count: number; tools: number }>(
      db,
      `SELECT e.confidence, e.source_count, COUNT(DISTINCT o.tool) AS tools
       FROM edges e JOIN edge_observations o ON o.edge_id = e.id GROUP BY e.id`,
    );
    for (const r of rows) {
      expect(r.source_count).toBe(r.tools);
      expect(r.confidence).toBe(r.source_count >= 2 ? 'corroborated' : 'discovered');
    }
    expect(all(db, 'SELECT id FROM edges WHERE id NOT IN (SELECT edge_id FROM edge_observations)')).toEqual([]);
  });

  test('covers every tag; an interesting node has a markdown note', () => {
    expect(new Set(column(db, 'SELECT DISTINCT tag AS v FROM nodes WHERE tag IS NOT NULL'))).toEqual(new Set(TAGS));
    const notes = column(db, "SELECT notes AS v FROM nodes WHERE tag = 'interesting'");
    expect(notes.some((n) => n?.includes('**'))).toBe(true);
  });

  test('a node only ever named as a parent: source_count 0, discovered', () => {
    const rows = all<{ value: string; confidence: string }>(
      db,
      "SELECT value, confidence FROM nodes WHERE source_count = 0 AND type != 'aggregate'",
    );
    expect(rows).toEqual([{ value: `legacy.${SHOWCASE_DOMAIN}`, confidence: 'discovered' }]);
  });

  test('an IP shared by two subdomains, and an IPv6 address', () => {
    const shared = all<{ n: number }>(
      db,
      `SELECT COUNT(DISTINCT e.source_id) AS n FROM edges e JOIN nodes s ON s.id = e.source_id
       WHERE e.relation = 'resolves_to' AND s.type = 'subdomain' GROUP BY e.target_id HAVING n >= 2`,
    );
    expect(shared.length).toBeGreaterThanOrEqual(1);
    expect(column(db, "SELECT value AS v FROM nodes WHERE type = 'ip'").some((v) => v?.includes(':'))).toBe(true);
  });

  test('starts collapsed: the domain and its groups, with the critical findings on the badge', async () => {
    const api = await testApi({ db });
    const g = body(await api.get('/api/graph'), 200, graphResponseSchema);
    const domain = nodeId('domain', SHOWCASE_DOMAIN);
    expect(g.nodes.filter((n) => n.type !== 'aggregate').map((n) => n.id)).toContain(domain);
    const subs = g.nodes.find((n) => n.id === `agg:${domain}:has_subdomain:subdomain`);
    expect(subs).toMatchObject({ type: 'aggregate', expanded: false, maxSeverity: 'critical' });
    expect(subs?.type === 'aggregate' && subs.risk.critical).toBeGreaterThan(0);
  });

  test('groups nest three deep: subdomains → app’s URLs → the endpoints app.js links to', async () => {
    const api = await testApi({ db });
    const exportUrl = nodeId('url', `https://app.${SHOWCASE_DOMAIN}/api/v1/admin/export`);
    const path = body(await api.get(`/api/graph/path/${exportUrl}`), 200, graphPathResponseSchema);
    const app = (p: string) => nodeId('url', `https://app.${SHOWCASE_DOMAIN}${p}`);
    expect(path.steps.map((s) => s.groupId)).toEqual([
      `agg:${nodeId('domain', SHOWCASE_DOMAIN)}:has_subdomain:subdomain`,
      `agg:${app('/')}:has_url:url`,
      `agg:${app('/static/app.js')}:has_url:url`,
    ]);
  });
});

describe('the showcase scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'redwhale-showcase-scope-'));
  let db: Db;
  beforeAll(() => {
    db = showcaseDb(dir);
  });
  afterAll(() => {
    db.$client.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const D = SHOWCASE_DOMAIN;
  const decide = (type: 'domain' | 'subdomain' | 'ip' | 'port' | 'url' | 'technology', value: string) =>
    compileScope(currentScope(db)).check(type, value, 'passive');

  test('is seeded through addRule, with passive-only left on', () => {
    expect(listRules(db).map((r) => [r.kind, r.value, r.action])).toEqual(
      SHOWCASE_SCOPE.map((r) => [r.kind, r.value, r.action]),
    );
    expect(getSettings(db).passiveOnly).toBe(true);
  });

  test('uses every rule kind and both actions', () => {
    expect(new Set(SHOWCASE_SCOPE.map((r) => r.kind))).toEqual(new Set(SCOPE_KINDS));
    expect(new Set(SHOWCASE_SCOPE.map((r) => r.action))).toEqual(new Set(SCOPE_ACTIONS));
  });

  test('every node is decided, and every decision occurs', () => {
    const decisions = all<{ type: 'domain'; value: string }>(db, 'SELECT type, value FROM nodes').map(
      (n) => decide(n.type, n.value).decision,
    );
    expect(new Set(decisions)).toEqual(new Set(SCOPE_DECISIONS));
  });

  test('every case is on the graph', () => {
    expect(decide('domain', D)).toMatchObject({ decision: 'in', rule: { kind: 'domain' } });
    expect(decide('subdomain', `api.${D}`)).toMatchObject({ decision: 'in', rule: { kind: 'wildcard' } });
    expect(decide('subdomain', `dev.${D}`)).toMatchObject({ decision: 'out', rule: { action: 'exclude' } });
    expect(decide('url', `https://dev.${D}/.git/config`).decision).toBe('out');
    expect(decide('ip', '198.18.0.10')).toMatchObject({ decision: 'in', rule: { kind: 'cidr' } });
    expect(decide('url', 'http://198.18.0.10/').decision).toBe('in');
    expect(decide('ip', '198.18.0.30')).toMatchObject({ decision: 'in', rule: { kind: 'ip' } });
    expect(decide('ip', '2001:db8::25').decision).toBe('in');
    expect(decide('technology', 'nginx/1.18.0').decision).toBe('n/a');
  });

  test('a CDN-style IP: in-scope subdomains resolve to it, but it is out', () => {
    const cdn = '198.18.0.20';
    const parents = column(
      db,
      `SELECT p.value AS v FROM edges e JOIN nodes p ON p.id = e.source_id JOIN nodes c ON c.id = e.target_id
       WHERE e.relation = 'resolves_to' AND c.value = '${cdn}' ORDER BY p.value`,
    );
    expect(parents).toEqual([`api.${D}`, `app.${D}`]);
    for (const p of parents) expect(decide('subdomain', p ?? '').decision).toBe('in');
    const result = decide('ip', cdn);
    expect(result.decision).toBe('out');
    expect(result.reason).toMatch(/domain rules never cover IP addresses/);
    expect(decide('port', `${cdn}:443/tcp`).decision).toBe('out');
  });
});

describe('the large mock scope', () => {
  test('has in, out and n/a nodes, an excluded subdomain, and out-of-scope IPs under in-scope subdomains', () => {
    const dir = tempDir();
    const path = join(dir, 'large.db');
    const result = run('large', ['--subdomains', '400', '--out', join(dir, 'out'), '--db', path, '--skip-python']);
    expect(result.code, result.err.join('\n')).toBe(0);
    const db = openDb(path);
    try {
      const scope = compileScope(currentScope(db));
      const nodes = all<{ type: 'ip'; value: string }>(db, 'SELECT type, value FROM nodes');
      expect(new Set(nodes.map((n) => scope.check(n.type, n.value, 'passive').decision))).toEqual(new Set(SCOPE_DECISIONS));
      expect(nodes.some((n) => scope.check(n.type, n.value, 'passive').rule?.action === 'exclude')).toBe(true);
      const resolved = all<{ sub: string; ip: string }>(
        db,
        `SELECT p.value AS sub, c.value AS ip FROM edges e JOIN nodes p ON p.id = e.source_id JOIN nodes c ON c.id = e.target_id
         WHERE e.relation = 'resolves_to' AND p.type = 'subdomain'`,
      );
      const split = resolved.filter(
        (r) => scope.check('subdomain', r.sub, 'passive').decision === 'in' && scope.check('ip', r.ip, 'passive').decision === 'out',
      );
      expect(split.length).toBeGreaterThan(0);
      expect(resolved.some((r) => scope.check('ip', r.ip, 'passive').decision === 'in')).toBe(true);
    } finally {
      db.$client.close();
    }
  });
});

describe('wiping the workspace', () => {
  test.each([
    ['showcase.example', true],
    ['northwind.example', true],
    ['https://app.showcase.example/', true],
    ['example', true],
    ['example.com', false],
    ['10.0.0.0/24', false],
    ['https://dev.example.com', false],
    ['notexample', false],
  ])('isMockTarget(%s) = %s', (target, expected) => {
    expect(isMockTarget(target)).toBe(expected);
  });

  test('refuses a database holding a real scan, and leaves it untouched', () => {
    const dir = tempDir();
    const path = join(dir, 'real.db');
    const db = openDb(path);
    expect(ingestText(db, exampleText('nmap')).status).toBe('ingested');
    const before = counts(db);
    db.$client.close();

    const result = run('showcase', ['--out', join(dir, 'out'), '--db', path, '--skip-python']);
    expect(result.code).toBe(1);
    expect(result.err).toContain(
      `${path} holds 1 scan(s) that didn't come from a mock generator (their target is not under .example):`,
    );
    expect(result.err.at(-1)).toMatch(/Pass --force to wipe them too/);

    const after = openDb(path);
    expect(counts(after)).toEqual(before);
    after.$client.close();
  });

  test('--force wipes real scans too', () => {
    const dir = tempDir();
    const path = join(dir, 'real.db');
    const db = openDb(path);
    ingestText(db, exampleText('nmap'));
    db.$client.close();

    const result = run('showcase', ['--out', join(dir, 'out'), '--db', path, '--skip-python', '--force']);
    expect(result.code, result.err.join('\n')).toBe(0);
    expect(result.out).toContain(`Wiped ${path} (1 scans, 1 not from a mock)`);
    const after = openDb(path);
    expect(foreignScans(after)).toEqual([]);
    after.$client.close();
  });

  test('switching from the large mock to the showcase replaces it', () => {
    const dir = tempDir();
    const path = join(dir, 'switch.db');
    const common = ['--out', join(dir, 'out'), '--db', path, '--skip-python'];
    expect(run('large', ['--subdomains', '30', ...common]).code).toBe(0);
    expect(run('showcase', common).code).toBe(0);
    const db = openDb(path);
    expect(column(db, "SELECT value AS v FROM nodes WHERE type = 'domain'")).toEqual([SHOWCASE_DOMAIN]);
    db.$client.close();
  });

  test('wipeWorkspace empties every table', () => {
    const db = showcaseDb();
    expect(wipeWorkspace(db)).toBeGreaterThan(0);
    expect(counts(db)).toMatchObject({ scans: 0, nodes: 0, edges: 0, observations: 0 });
    // The scope goes too (a mock workspace is disposable), and passive-only is back on.
    db.$client.prepare("UPDATE scope_settings SET passive_only = 0").run();
    db.$client.prepare("INSERT INTO scope_log (source, target_type, target_value, mode, decision, reason, at) VALUES ('check', 'ip', '1.2.3.4', 'passive', 'out', 'r', 'now')").run();
    wipeWorkspace(db);
    expect(all(db, 'SELECT * FROM scope_rules')).toEqual([]);
    expect(all(db, 'SELECT * FROM scope_log')).toEqual([]);
    expect(getSettings(db).passiveOnly).toBe(true);
    db.$client.close();
  });

  test.each([['--subdomains', '10'], ['--seed', '1'], ['--domain', 'x.example']])(
    'pnpm mock rejects %s (it is for mock:large)',
    (flag, value) => {
      const result = run('showcase', [flag, value]);
      expect(result.code).toBe(2);
      expect(result.err[0]).toBe(`${flag} is for pnpm mock:large; pnpm mock is a fixed showcase`);
    },
  );
});
