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
| 4 | Docs (contract changelog, architecture §11/§13, team-guide, handoff) + manual checklist here | done |

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
  - **Decided (user confirmed after step 4):** `takeover-dangling-cname` skips NXDOMAIN names inside the target's
    **own** registrable domain (only the zone owner can create them); the hop keeps its `rcode` in its data. §13.
- **Fixtures**: all 8 cases (main = case 3, Microsoft 365 chain; 7 case folders replayed by the unit test). Real
  exchanges captured 2026-11-22 in the image with `LiveNet`; cases 4–8 assembled with edited CNAME lines, all in
  `fixtures/NOTE.md`. Case 5 is assembled too (no dangling CNAME on the authorized domain; a real NXDOMAIN under
  `azurewebsites.net`, Heroku answers every name). Anonymized: the target domain and the company's server domain
  (`ftp`'s chain ends there) → `northwind.example` / `northwind-servers.example`, their RDAP handles, registrar,
  dates, nameservers; every IP → `198.18.0.x`. Well-known third-party service names are kept (NOTE.md says why).
  Raw captures and the assembler stay in the session scratchpad only.
- Server tests updated for the new tool (catalog, `/api/tools`, fixtures list, `tools:check` count 9).

## Step 4 (done)

- contract.md: §4 relation + §7 changelog (step 1). architecture.md: §4 (migrations run with foreign keys off,
  0006), §9 (dangling CNAME → done in TW-1; TW-2 list), §11 (dns group + a takeover-check section: chain,
  registrations, private suffixes, findings, transcript replay, bundled data), §13 (12 rows dated 2026-11-24).
- `tools/dns/README.md` (group renamed "DNS", takeover-check section), team-guide (copy-table row; "If your tool
  makes several requests": investigate/LiveNet/ReplayNet, transcript, politeness, assembled fixtures), handoff
  (status, TW-1 row, key decision, open items incl. TW-2).

## Manual check (PowerShell, from the repo root)

**Setup** (proves: the image builds with the pinned Debian whois and the bundled data; fixtures replay offline;
your existing database migrates with its data):

1. `git switch phase-tw1`, then `pnpm install`.
2. `pnpm tools:build dns`: the log shows apt installing `whois (5.6.3)`; the tag changes (new script, data, psl.py).
   (`pnpm tools:build` also rebuilds the other groups: `lib/` changed.)
3. `pnpm tools:check --all`: `✓ all 9 passed` (takeover-check replays its main fixture and runs
   `test_takeover_check.py`, which replays the 7 case folders; no Docker or network).
4. `pnpm dev` on your current `data/redwhale.db`: no "Database is from an older schema" message, and the graph,
   jobs and edges you had are all still there (migration 0006 rebuilt `edges` and kept every row).
5. Optional, on a scratch database: `pnpm mock -- --db data/tw1-mock.db`, then start the API on it
   (`$env:REDWHALE_DB = "data/tw1-mock.db"`, `pnpm dev`): `api.showcase.example —cname_to→ app.showcase.example`
   is drawn; select the edge: relation `cname_to`, tool dnsx. Remove the variable afterwards
   (`Remove-Item Env:REDWHALE_DB`).

**The relation in the UI** (proves: the contract change reached the Add node dialog):

6. Right-click a subdomain ▸ Add child node…: the type list starts `domain, subdomain, ip, …`; pick `subdomain` or
   `domain`: Relation shows `cname_to`. Cancel.

**A real run on a subdomain you are authorized to test** (proves: passive, scope-checked, a real chain and real
registrations end to end, through the normal ingest):

7. Scope panel: include your domain's wildcard (`*.<your domain>`) or the subdomain itself. Passive-only can stay
   **on** (the tool is passive).
8. Pick a subdomain with a CNAME to a third-party service (an `autodiscover.` → Microsoft 365, a CDN, a SaaS
   status page…). Right-click it ▸ Run tool ▸ **Takeover check**: **no** confirmation dialog (passive). The job
   succeeds in about 5–30 s (each RDAP server is asked at most once a second).
9. What to look for in the graph:
   - each CNAME hop under the previous name with a `cname_to` edge, in order; each hop's data has `rcode`
     (`NOERROR` normally), and `service` if it is under a cloud suffix (e.g. `azurewebsites.net`, `herokuapp.com`);
   - each hop subdomain also under its registrable domain (`has_subdomain`); names outside your scope are hatched;
   - one `domain` per registrable domain looked up, **without a parent**: your own domain and each external one, with
     `registered: true`, `expires_at`, `registrar`, `created_at`, `source: rdap` (or `whois` for e.g. `.io`/`.de`),
     `checked_at`; an unknown one has `registered: null` and a `reason` (the job is then `partial`);
   - the subdomain itself is **not** a new finding; normally no vulnerability (a healthy chain).
   - If your own domain was already found by a subdomain tool, it is now **corroborated** (2 tools): the RDAP record
     counts as evidence (the decided exception to the 6C-3 rule).
10. Jobs tab ▸ the job: the command is the first dnsx line (`/usr/local/bin/dnsx -l <subdomain> -cname -j -silent
    -nc -duc -or -retry 2 -timeout 5s -t 1 -rl 10 -r 127.0.0.11:53  (+ N more DNS/RDAP/WHOIS exchanges, in raw.txt)`).
    Open `data\jobs\<id>\raw.txt` (the transcript): every `rdap` exchange's `url` is `https://` on a server from
    `bootstrap`, no exchange went to the subdomain itself, and there is no `-d`/`-w` in any dnsx argv.
11. Replay it offline (proves: the transcript alone reproduces the findings):
    `py -3 tools/dns/takeover-check/run.py --target <subdomain> --target-type subdomain --out $env:TEMP\rw-tc --replay data\jobs\<id>\raw.txt`
    then `Get-Content $env:TEMP\rw-tc\result.json`: the same findings as the job.
12. Run it again on the same subdomain: no duplicate nodes or edges (the hop and domain nodes get a second
    observation; still `discovered`, one tool).
13. Run it on a subdomain **without** a CNAME: one finding, your own domain.
14. Right-click your **domain** node ▸ Run tool: Takeover check is not offered (it accepts subdomains only).

**Refusal without a resolver** (no Docker needed; proves: it never falls back to public resolvers):

15. `py -3 tools/dns/takeover-check/run.py --target www.northwind.example --target-type subdomain --out $env:TEMP\rw-tc2`
    then `Get-Content $env:TEMP\rw-tc2\result.json`: `"status": "failed"`, "no system resolver found; refusing to
    use public ones" (Windows has no `/etc/resolv.conf`); nothing ran.

Decided: an NXDOMAIN hop inside the target's own domain is not a `takeover-dangling-cname` (its `rcode` stays in the
hop's data; §13).

## Next action

All four steps are done and pushed. Waiting for the user's manual check (above), after 6C-4's; the user merges
`phase-6c4`, then `phase-tw1`. TW-2 is not started.
