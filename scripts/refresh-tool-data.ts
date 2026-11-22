// pnpm tools:refresh-data: re-downloads the data files bundled with the `dns` tool group (tools/dns/data/) and
// rewrites their README (source, fetch date, sha256). This is the only place they are downloaded: images copy them
// from the build context (so a refresh changes the dns image's tag), and nothing fetches them at build or run time.
// Works the same in PowerShell, cmd and bash (no shell features).
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'dns', 'data');

interface Source {
  file: string;
  url: string;
  what: string;
  /** Throws if the download isn't what we expect; returns the version line for the README. */
  check: (text: string) => string;
}

const SOURCES: Source[] = [
  {
    file: 'public_suffix_list.dat',
    url: 'https://publicsuffix.org/list/public_suffix_list.dat',
    what: 'Public Suffix List (ICANN and private sections), read by `tools/lib/psl.py`',
    check: (text) => {
      for (const marker of ['===BEGIN ICANN DOMAINS===', '===END ICANN DOMAINS===', '===BEGIN PRIVATE DOMAINS===', '===END PRIVATE DOMAINS===']) {
        if (!text.includes(marker)) throw new Error(`public_suffix_list.dat has no "${marker}" line: not the PSL?`);
      }
      const version = /^\/\/ VERSION: (.+)$/m.exec(text)?.[1]?.trim();
      const commit = /^\/\/ COMMIT: (.+)$/m.exec(text)?.[1]?.trim();
      return [version && `VERSION ${version}`, commit && `COMMIT ${commit}`].filter(Boolean).join(', ') || 'no version line';
    },
  },
  {
    file: 'dns.json',
    url: 'https://data.iana.org/rdap/dns.json',
    what: "IANA's RDAP bootstrap for domain names (RFC 9224): TLD → RDAP base URLs, read by `takeover-check`",
    check: (text) => {
      const doc: unknown = JSON.parse(text);
      if (typeof doc !== 'object' || doc === null || !('services' in doc) || !Array.isArray(doc.services)) {
        throw new Error('dns.json has no "services" array: not the RDAP bootstrap?');
      }
      const publication = 'publication' in doc && typeof doc.publication === 'string' ? doc.publication : 'unknown';
      return `publication ${publication}, ${String(doc.services.length)} services`;
    },
  },
];

async function download(source: Source): Promise<{ bytes: Buffer; version: string }> {
  const res = await fetch(source.url, { headers: { 'User-Agent': 'redwhale-refresh-data/1' }, redirect: 'error' });
  if (!res.ok) throw new Error(`${source.url}: HTTP ${String(res.status)}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  return { bytes, version: source.check(bytes.toString('utf8')) };
}

async function main(): Promise<void> {
  // Download and check both before writing either, so a failure leaves the bundled pair as it was.
  const got = await Promise.all(SOURCES.map(async (s) => ({ source: s, ...(await download(s)) })));
  mkdirSync(DATA_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const rows: string[] = [];
  for (const { source, bytes, version } of got) {
    writeFileSync(join(DATA_DIR, source.file), bytes);
    const sha = createHash('sha256').update(bytes).digest('hex');
    rows.push(`| \`${source.file}\` | ${source.url} | ${date} | ${version} | \`${sha}\` |`);
    console.log(`✓ ${source.file}  ${String(bytes.length)} bytes  sha256 ${sha}  (${version})`);
  }
  const readme = [
    '# Bundled data for the `dns` tool group',
    '',
    'Written by `pnpm tools:refresh-data` (`scripts/refresh-tool-data.ts`); do not edit by hand. That command is the',
    'only place these files are downloaded: `pnpm tools:build dns` copies them into the image from the build context',
    '(so refreshing them changes the image tag), and no tool fetches them at run time.',
    '',
    ...SOURCES.map((s) => `- \`${s.file}\`: ${s.what}.`),
    '',
    '| File | Source | Fetched | Version | sha256 |',
    '|---|---|---|---|---|',
    ...rows,
    '',
    'After a refresh: `pnpm test` (the PSL parity vectors in `tools/lib/fixtures/psl_vectors.json` are checked against',
    "both `psl.py` and the server's `tldts`), then `pnpm tools:build dns`. Fixtures don't change: each takeover-check",
    'transcript carries the bootstrap entries its run used.',
    '',
  ].join('\n');
  writeFileSync(join(DATA_DIR, 'README.md'), readme);
  console.log(`✓ ${join('tools', 'dns', 'data', 'README.md')}`);
}

main().catch((e: unknown) => {
  console.error(`✗ ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
