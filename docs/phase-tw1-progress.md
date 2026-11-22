# Phase TW-1 progress: subdomain takeover checks (Takeover watch, first half)

Branch `phase-tw1`, from `phase-6c4`'s tip (6C-4 isn't merged yet; the user merges both after their manual checks).
Checkpoint method: each step ends green (`pnpm typecheck` + `pnpm test`), then this file, a commit
`TW-1 step N: <what>` and a push. Never merged to main by Claude.

Scope: contract relation `cname_to`; bundled PSL + RDAP bootstrap + `tools/lib/psl.py`; the passive tool
`takeover-check` in the `dns` group. Not in scope (TW-2+): the Takeover watch panel, scheduled runs, HTTP
fingerprints of cloud services, TLS expiry, any active probing.

## Steps

| # | Step | State |
|---|---|---|
| 1 | Contract `cname_to` everywhere + tests (+ migration 0006) | done |
| 2 | Bundled PSL + RDAP bootstrap + `pnpm tools:refresh-data` + `psl.py` + parity vectors | next |
| 3 | `takeover-check`: Dockerfile (pinned `whois`), tool.json, run.py, transcript replay, fixtures, unit tests | |
| 4 | Docs (contract changelog, architecture §11/§13, team-guide, handoff) + manual checklist here | |

## Decisions (from the plan review)

- **Branch base:** `phase-6c4`, not `main` (main stops at 6C-3).
- **External domains have no parent.** A chain subdomain hangs under its registrable domain
  (`evil.com —has_subdomain→ a.evil.com`); a hop that *is* the registrable domain (`… —cname_to→ evil.com`) carries
  the registration data itself. (`has_subdomain` only goes domain → subdomain.)
- **Fixtures:** real exchanges where they exist; cases 4 (RDAP 404), 6 (loop), 7 (WHOIS fallback), 8 (RDAP timeout)
  are transcripts assembled from real exchanges with the chain edited, all marked in NOTE.md. No DNS zone to create
  records in.
- **WHOIS never says "not registered":** `true` with a parsed expiry date, or unknown. `registered: false` (and the
  critical finding) only from an RDAP 404.
- **RDAP redirects are not followed:** a 3xx is unknown ("redirect to <host>"), so no undeclared host is contacted.
- **Transcript replay:** one `investigate(target, net)` runs against a live net (records every exchange) and, in
  `parse()`, against a replay net built from the transcript, so live runs and `--replay` build findings through one
  code path. The transcript records the bootstrap entries the run used (`bootstrap`), so fixtures keep replaying after
  a data refresh and anonymized `.example` names can stand in for real TLDs.

## Step 1 (done)

- `cname_to: subdomain → subdomain | domain` in `shared/src/enums.ts` (so `relationsBetween`, `childTypesOf`,
  `parentTypesOf`, contract Zod, manual nodes, graph routes follow), `tools/validate_output.py`, contract.md §4 + new
  §7 changelog. Still at most one relation per type pair (tested), so the Add node dialog still pre-fills.
- `validate_output.py`'s RELATIONS are now ordered tuples in enums.ts's order and the message joins them with `, `:
  the "can't link" message is word for word Zod's for every relation (was Python's `sorted()` list repr).
- **Schema change (approved by the user mid-step):** `edges` has a CHECK on `relation`, so ingest refused `cname_to`.
  Migration `0006_cname_to` (drizzle-kit generated) rebuilds `edges` and copies every row: **not** breaking.
  `openDb()` now runs migrations with `foreign_keys` OFF, then `foreign_key_check` (throws on any broken key), then ON:
  the migration file's own `PRAGMA foreign_keys=OFF` is a no-op inside migrate()'s transaction, and without this the
  rebuild failed with "FOREIGN KEY constraint failed" on any database with edge observations (test proved it).
- Showcase: `api —cname_to→ app` (they already share an IP; no new node, stays ≤ 80).
- Dialog: a domain's parent picker now offers subdomains (CNAME target); the "is a root" text can no longer appear
  (every type has a parent type now) but stays as a guard.
- Tests: Zod/Python accept subdomain→subdomain|domain and refuse domain→subdomain, domain→domain, subdomain→ip,
  ip→subdomain with the same message (`parity.test.ts`); `contract/invalid/relation-cname-to-wrong-types.json`;
  `relationsBetween`/`parentTypesOf`/`childTypesOf`; dialog pre-fill under a subdomain; a populated 0005 database
  migrates with edges, edge observations and indexes intact and accepts `cname_to` (`db.test.ts`).

## Next action

Step 2: download `public_suffix_list.dat` and IANA `dns.json` into `tools/dns/data/` via a new
`scripts/refresh-tool-data.ts` (`pnpm tools:refresh-data`), write `tools/dns/data/README.md` (URL, date, sha256),
then `tools/lib/psl.py` + `tools/lib/fixtures/psl_vectors.json`, checked by `tools/lib/test_psl.py` and
`shared/test/psl-parity.test.ts` (tldts 7.4.18).
