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
| 2 | Bundled PSL + RDAP bootstrap + `pnpm tools:refresh-data` + `psl.py` + parity vectors | done |
| 3 | `takeover-check`: Dockerfile (pinned `whois`), tool.json, run.py, transcript replay, fixtures, unit tests | done |
| 4 | Docs (contract changelog, architecture §11/§13, team-guide, handoff) + manual checklist here | next |

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

## Step 2 (done)

- `pnpm tools:refresh-data` (`scripts/refresh-tool-data.ts`, Node `fetch`, `redirect: 'error'`): downloads both
  files, checks them (PSL section markers; bootstrap `services` array), writes both only if both are good, rewrites
  `tools/dns/data/README.md` (source, date, version line, sha256). First fetch 2026-11-24: PSL `VERSION
  2026-11-21_04-33-45_UTC`, bootstrap `publication 2026-11-20T23:00:03Z` (592 services); sha256s in the README.
- `.gitattributes`: `tools/dns/data/*.dat` and `*.json` are `-text` (bytes kept, so the README sha256 holds on every
  OS). README.md is outside every build context; the two data files are inside the dns group's (a refresh changes
  its tag). A `data/` folder has no tool.json, so the catalog ignores it.
- `tools/lib/psl.py`: ICANN and PRIVATE kept apart; normal, wildcard, exception rules; default `*`; Unicode rules →
  punycode per label; `registrable()` (ICANN only), `private_suffix()` (strictly below a PRIVATE rule),
  `public_suffix()`. Lines outside both sections are ignored.
- 25 parity vectors in `tools/lib/fixtures/psl_vectors.json` (outside every build context): co.uk, com.eg, `*.ck` /
  `!www.ck`, `*.kawasaki.jp` / `!city.kawasaki.jp`, IDN TLD and IDN rule as punycode, github.io, herokuapp.com,
  s3.amazonaws.com, blogspot.com, unlisted TLDs (`northwind.example`), bare suffixes. psl.py and tldts 7.4.18 agree on
  all 25 (`tools/lib/test_psl.py`, run by `server/test/tools-python.test.ts`; `shared/test/psl-parity.test.ts`).
- TLDs with no RDAP in this bootstrap (WHOIS fallback candidates): io, de, jp, co, me, eg, ru, cn, sh.

## Step 3 (done)

- **dnsx v1.3.1, checked in the image** (`dnsx -h` and live tries): `-t` is threads, the timeout is `-timeout`. An
  rcode is only printed by the plain `-rcode` mode (an A query); with `-cname` (alone or with `-a`), a name with no
  CNAME or NXDOMAIN prints **nothing**, even with `-rcode`, and `-rtf cname` prints nothing either. A `-cname` line
  carries `status_code`. So each hop is two calls at most:
  `dnsx -l <name> -cname -j -silent -nc -duc -or -retry 2 -timeout 5s -t 1 -rl 10 -r <own>`, and only when it prints
  nothing, `dnsx -l <name> -rcode noerror,nxdomain,servfail,refused` (same other flags). A recursive resolver answers a
  CNAME question with the one CNAME record (checked on a 4-hop Microsoft chain), so hop-by-hop is exact.
- **whois 5.6.3** (Debian trixie, `apt-cache policy whois` in the digest-pinned base, depends only on libc6,
  libcrypt1, libidn2-0), pinned in `tools/dns/Dockerfile` with nmap's bump message. The image also gets
  `lib/psl.py` and `dns/data/`. Group label `DNS resolution` → `DNS`; tools `["dnsx", "takeover-check"]`.
- `tools/dns/takeover-check/`: tool.json (passive, `accepts: ["subdomain"]`, `{targetType}`, `timeoutSec` 300,
  external: system DNS resolver, RDAP servers (IANA bootstrap), WHOIS servers (fallback)), run.py, 43 unit tests,
  fixtures.
- **Design as built** (run.py's docstring has the rest):
  - `investigate(target, net, psl)` is the only logic. `fetch()` runs it on `LiveNet` (records every exchange);
    `parse()` always re-runs it on `ReplayNet(transcript)`, so live and `--replay` share one path. A missing answer
    in a truncated transcript stops only that step (chain or lookup), with an error saying which.
  - Transcript: `{"transcript": 1, tool, target, target_type, data: {psl/bootstrap sha256 + versions}, bootstrap:
    {domain: {entry, servers}}, exchanges: [...]}`; a dns exchange keeps argv, at, exit, stdout, stderr, error; an
    rdap one url, every attempt (at, status, error, location on a 3xx) and the body (≤ 1 MB); a whois one argv,
    stdout. The bootstrap is keyed **by domain** (what each lookup used), not by TLD.
  - RDAP: the first `https://` base URL of the longest matching bootstrap entry; `Accept: application/rdap+json`;
    no redirect following (`NoRedirect` handler); retry on timeouts and 429/5xx (2 retries, backoff 2 s, 5 s);
    ≥ 1 s between requests to one server host; whois ≥ 1 s per TLD; all within the job's time budget.
  - WHOIS labels (documented in run.py): registry expiry date, registrar registration expiration date, expiry date,
    expiration date, expiration time, expires on, expire date, paid-till, expires. Dates in a fixed list of formats;
    anything else → unknown.
  - Unknown registrations, loops, >10 hops, public-suffix CNAME targets and DNS failures are `run.error`s, so the
    status is `partial`.
  - A CNAME at a registrable domain (apex) can't be a `cname_to` edge (only subdomains have it): the next name is
    reported without that edge, with a log line. Not covered by a fixture (rare and illegal DNS).
  - **Decision to confirm:** `takeover-dangling-cname` skips NXDOMAIN names inside the target's **own**
    registrable domain (the zone owner's to fix; nobody else can claim it). The plan's rule read literally would
    flag them too.
- **Fixtures**: all 8 cases (main = case 3, Microsoft 365 chain; 7 case folders replayed by the unit test). Real
  exchanges captured 2026-11-22 in the image with `LiveNet`; cases 4–8 assembled with edited CNAME lines, all in
  `fixtures/NOTE.md`. Case 5 is assembled too (no dangling CNAME on the authorized domain; a real NXDOMAIN under
  `azurewebsites.net`, Heroku answers every name). Anonymized: the target domain and the company's server domain
  (`ftp`'s chain ends there) → `northwind.example` / `northwind-servers.example`, their RDAP handles, registrar,
  dates, nameservers; every IP → `198.18.0.x`. Well-known third-party service names are kept (NOTE.md says why).
  Raw captures and the assembler stay in the session scratchpad only.
- Server tests updated for the new tool (catalog, `/api/tools`, fixtures list, `tools:check` count 9).

## Next action

Step 4: docs. contract.md already has the relation and the changelog (step 1). Write architecture §11 (dns group:
takeover-check, transcript replay; migration 0006 mention under §4 if needed) and §13 (decisions: cname_to + node
type by PSL; 0006 + foreign keys off while migrating; bundled data + refresh; psl.py parity; takeover-check
command/flags; whois pin; the target's own domain as a finding = exception to the 6C-3 rule; no RDAP redirects;
WHOIS never false; dangling skips own domain), `tools/dns/README.md`, team-guide (several-requests tools, transcript
replay, new copy-row), handoff status, and the manual checklist in this file.
