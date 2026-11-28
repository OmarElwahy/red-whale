// Bug-report drafts (server/src/report/build.ts) and GET /api/nodes/:id/report.
import { nodeId, nodeReportSchema } from '@redwhale/shared';
import { describe, expect, test } from 'vitest';
import { ingestText } from '../src/ingest/ingest';
import { buildReport, codeBlock, escapeMarkdown, nodeReport, pathToRoot, type ReportInput } from '../src/report/build';
import { nodeDetail } from '../src/routes/nodes';
import { body, error, testApi } from './api/helpers';
import { baseDoc, freshDb, type Doc } from './helpers';

const D = 'northwind.example';
const APP = `app.${D}`;
const IP = '10.0.0.5';
const PORT = `${IP}:443/tcp`;
const URL1 = `https://${APP}/.git/config`;
const URL2 = `https://${APP}/backup/.git/config`;
const NOW = new Date('2026-11-28T12:00:00.000Z');

const f = (type: string, value: string, parent?: [string, string], relation?: string, extra: Record<string, unknown> = {}) => ({
  type,
  value,
  ...(parent ? { parent: { type: parent[0], value: parent[1] }, relation } : {}),
  ...extra,
});

/** domain → subdomain → ip → port → url → vulnerability (and a second url with the same vulnerability). */
function chainDoc(vulnData: Record<string, unknown> = {}): Doc {
  return baseDoc({
    tool: 'nuclei',
    target: `https://${APP}`,
    command: `nuclei -u https://${APP} -jsonl`,
    findings: [
      f('domain', D),
      f('subdomain', APP, ['domain', D], 'has_subdomain'),
      f('ip', IP, ['subdomain', APP], 'resolves_to'),
      f('port', PORT, ['ip', IP], 'has_port'),
      f('url', URL1, ['port', PORT], 'serves'),
      f('url', URL2, ['port', PORT], 'serves'),
      f('vulnerability', 'git-config', ['url', URL1], 'has_vulnerability', {
        severity: 'medium',
        data: { template: 'git-config', name: 'Git Configuration - Detect', matched_at: URL1, ...vulnData },
      }),
      f('vulnerability', 'git-config', ['url', URL2], 'has_vulnerability', { severity: 'medium' }),
    ],
  });
}

function ingest(doc: Doc) {
  const db = freshDb();
  const r = ingestText(db, JSON.stringify(doc));
  if (r.status !== 'ingested') throw new Error(JSON.stringify(r));
  return db;
}

const vulnId = nodeId('vulnerability', 'git-config');

describe('escaping', () => {
  test('Markdown characters are escaped, leading markers too, line breaks folded; the rest stays readable', () => {
    expect(escapeMarkdown('[a](javascript:x) <b> &amp; # *c* `d` ~e~ |f|\n- g')).toBe(
      '\\[a\\](javascript:x) \\<b\\> \\&amp; # \\*c\\* \\`d\\` \\~e\\~ \\|f\\| - g',
    );
    expect(escapeMarkdown('  # heading', true)).toBe('\\# heading');
    expect(escapeMarkdown('- item', true)).toBe('\\- item');
    expect(escapeMarkdown('---', true)).toBe('\\---');
    expect(escapeMarkdown('1. item', true)).toBe('1\\. item');
    expect(escapeMarkdown('2) item', true)).toBe('2\\) item');
    // Mid-line, a leading marker means nothing.
    expect(escapeMarkdown('9.8')).toBe('9.8');
    expect(escapeMarkdown('# x')).toBe('# x');
    expect(escapeMarkdown('git-config on app.northwind.example/x')).toBe('git-config on app.northwind.example/x');
  });

  test('a code fence is longer than any backtick run inside', () => {
    expect(codeBlock('a ``` b')).toBe('````\na ``` b\n````');
    expect(codeBlock('plain')).toBe('```\nplain\n```');
  });
});

describe('pathToRoot', () => {
  test('root → node along the shortest way up, ties by value', () => {
    const db = ingest(chainDoc());
    expect(pathToRoot(db, vulnId).map((n) => n.label)).toEqual([D, APP, IP, PORT, URL1, 'git-config']);
  });
});

describe('nodeReport', () => {
  test('every section, the path, the other parent, the provenance row', () => {
    const db = ingest(chainDoc({ cvss: 5.3, references: ['https://ref.example/a', 'not a url'], tags: ['git', 'exposure'] }));
    const r = nodeReport(db, vulnId, NOW);
    if (r === null || r === 'unsupported') throw new Error('no report');
    expect(nodeReportSchema.parse(r)).toEqual(r);
    expect(r).toMatchObject({ nodeId: vulnId, type: 'vulnerability', label: 'git-config', title: `Git Configuration - Detect on ${URL1}` });
    const md = r.markdown;
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toEqual([
      '## Severity',
      '## Affected asset',
      '## Description',
      '## References',
      '## Steps to reproduce',
      '## Evidence',
      '## Remediation',
      '## Analyst notes',
      '## Timeline',
    ]);
    expect(md).toContain('**Medium** · CVSS 5.3');
    expect(md).toContain('1. domain: northwind.example\n2. subdomain: app.northwind.example');
    expect(md).toContain('6. vulnerability: git-config');
    expect(md).toContain('Also affects:');
    expect(md).toContain(`url ${escapeMarkdown(URL2)}`);
    expect(md).toContain('- <https://ref.example/a>\n- not a url');
    expect(md).toContain(`\`\`\`\nnuclei -u https://${APP} -jsonl\n\`\`\``);
    expect(md).toContain('Ingested from a file: scan');
    expect(md).toContain('## Remediation\n\nTODO');
    expect(md).toContain('## Analyst notes\n\n_None._');
    expect(md).toContain('- Tools: nuclei');
    expect(md).toContain('- Confidence: discovered');
  });

  test('null for no node, unsupported for other types', () => {
    const db = ingest(chainDoc());
    expect(nodeReport(db, 'nope', NOW)).toBeNull();
    expect(nodeReport(db, nodeId('url', URL1), NOW)).toBe('unsupported');
  });
});

describe('buildReport', () => {
  function input(patch: (i: ReportInput) => void): ReportInput {
    const db = ingest(chainDoc());
    const detail = nodeDetail(db, vulnId);
    if (!detail) throw new Error('no node');
    const i: ReportInput = { detail, path: pathToRoot(db, vulnId), alsoAffects: [], moreParents: 0 };
    patch(i);
    return i;
  }

  test('masked values are kept as stored; job IDs point at the rest', () => {
    const r = buildReport(
      input((i) => {
        i.detail.node.data = { ...i.detail.node.data, extracted: ['user:****', 'AKIA****WXYZ'], matcher: ['status', 'word'] };
        const o = i.detail.observations[0];
        if (o) o.jobId = 12;
      }),
      NOW,
    );
    expect(r.markdown).toContain('Extracted values (masked):\n\n```\nuser:****\nAKIA****WXYZ\n```');
    expect(r.markdown).toContain('Matcher: status, word');
    expect(r.markdown).toContain('raw output of job 12 (local only)');
    expect(r.markdown).not.toContain('Ingested from a file');
  });

  test('hostile tool text stays text: no link, image, HTML, heading or broken fence', () => {
    const r = buildReport(
      input((i) => {
        i.detail.node.data = {
          name: '<script>alert(1)</script>',
          description: '![x](http://evil.example/p.png)\n# owned [click](javascript:alert(1))',
          references: ['javascript:alert(1)', 'https://evil.example/<img>'],
          extracted: ['```\n# not a heading'],
          remediation: '<img src=x onerror=alert(1)>',
          matched_at: ['# not a heading either', '1. not a list'],
        };
        const o = i.detail.observations[0];
        if (o) o.command = 'nuclei ``` -u x';
      }),
      NOW,
    );
    const md = r.markdown;
    expect(md).toContain('# \\<script\\>alert(1)\\</script\\>');
    expect(md).toContain('!\\[x\\](http://evil.example/p.png) # owned \\[click\\](javascript:alert(1))');
    expect(md).not.toMatch(/^# owned/m);
    expect(md).toContain('- javascript:alert(1)');
    expect(md).toContain('- <https://evil.example/%3Cimg%3E>');
    expect(md).toContain('````\n```\n# not a heading\n````');
    expect(md).toContain('````\nnuclei ``` -u x\n````');
    expect(md).toContain('\\<img src=x onerror=alert(1)\\>');
    expect(md).toContain('- \\# not a heading either\n- 1\\. not a list');
    // The plain-text title is not escaped (the HTML page escapes it).
    expect(r.title).toBe(`<script>alert(1)</script> on ${URL1}`);
  });

  test('missing fields: no CVSS, no references, no data, no severity, notes and other data kept', () => {
    const r = buildReport(
      input((i) => {
        i.detail.node.data = { detector: 'AWS', verified: false, fields: ['password', 'email'], nested: [{ a: 1 }] };
        i.detail.node.severity = null;
        i.detail.node.notes = 'Check **prod** first.';
      }),
      NOW,
    );
    const md = r.markdown;
    expect(md).toContain('## Severity\n\n**Not set**\n');
    expect(md).not.toContain('CVSS');
    expect(md).toContain('## References\n\n_None recorded._');
    expect(md).toContain('## Description\n\nA vulnerability: git-config.');
    expect(md).toContain('- detector: AWS\n- verified: false\n- fields: password, email\n- nested: \\[{"a":1}\\]');
    expect(md).toContain('## Analyst notes\n\nCheck **prod** first.');
    expect(r.title).toBe(`git-config on ${URL1}`);
  });

  test('cvss as an object with a vector', () => {
    const r = buildReport(
      input((i) => {
        i.detail.node.data = { cvss: { score: 9.8, vector: 'CVSS:3.1/AV:N' } };
      }),
      NOW,
    );
    expect(r.markdown).toContain('CVSS 9.8 (CVSS:3.1/AV:N)');
  });
});

describe('GET /api/nodes/:id/report', () => {
  test('a draft for a finding node, 400 for other types, 404 for none', async () => {
    const api = await testApi();
    const r = ingestText(api.db, JSON.stringify(chainDoc()));
    expect(r.status).toBe('ingested');
    const report = body(await api.get(`/api/nodes/${vulnId}/report`), 200, nodeReportSchema);
    expect(report.markdown).toContain('## Steps to reproduce');
    error(await api.get(`/api/nodes/${nodeId('url', URL1)}/report`), 400, 'reports are for vulnerability, secret, leak nodes');
    error(await api.get('/api/nodes/nope/report'), 404);
  });
});
