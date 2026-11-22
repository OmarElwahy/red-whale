# Bundled data for the `dns` tool group

Written by `pnpm tools:refresh-data` (`scripts/refresh-tool-data.ts`); do not edit by hand. That command is the
only place these files are downloaded: `pnpm tools:build dns` copies them into the image from the build context
(so refreshing them changes the image tag), and no tool fetches them at run time.

- `public_suffix_list.dat`: Public Suffix List (ICANN and private sections), read by `tools/lib/psl.py`.
- `dns.json`: IANA's RDAP bootstrap for domain names (RFC 9224): TLD → RDAP base URLs, read by `takeover-check`.

| File | Source | Fetched | Version | sha256 |
|---|---|---|---|---|
| `public_suffix_list.dat` | https://publicsuffix.org/list/public_suffix_list.dat | 2026-11-22 | VERSION 2026-11-21_04-33-45_UTC, COMMIT 87a2c1b8de5886a133ff4da21b2aa6fec88d8739 | `017501d3fa7911c60ac7e0f68df4122b07216c585c15dc30e0f0c74b8d13a2b9` |
| `dns.json` | https://data.iana.org/rdap/dns.json | 2026-11-22 | publication 2026-11-20T23:00:03Z, 592 services | `85c09e5c0ddeb09fe657aefc122d48ddb66ca20dc30ea7f6035d4dee849bd49d` |

After a refresh: `pnpm test` (the PSL parity vectors in `tools/lib/fixtures/psl_vectors.json` are checked against
both `psl.py` and the server's `tldts`), then `pnpm tools:build dns`. Fixtures don't change: each takeover-check
transcript carries the bootstrap entries its run used.
