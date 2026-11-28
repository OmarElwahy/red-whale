# Phase 6C-7 progress: WAF detection (wafw00f) and TLS checks (testssl.sh)

Branch `phase-6c7`, cut from `phase-6c6` (`feb293a`). Started 2026-11-24.

**Goal:** wafw00f (WAF detection) and testssl.sh (TLS checks), both active, findings on the graph.

**Not in scope:** certificate SANs as subdomain findings (later); testssl's HTTP header checks (`-h`), STARTTLS,
`--phone-out` (OCSP/CRL lookups); wafw00f `-a` (every signature); any WAF bypass.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | wafw00f in `http` (pin, tool.json, run.py, lab fake WAF, fixtures, tests) | done |
| 2 | `tls` group + testssl (Dockerfile, flags checked, tool.json, run.py, certificate/vuln parser, tests) | done |
| 3 | e2e (wafw00f; testssl fast + slow), results recorded here | done |
| 4 | Docs (§11/§13, group READMEs, team-guide rows, handoff) + manual checklist | done |

## Decisions (from the plan review)

- **Certificate parent:** the port `ip:port/tcp` testssl connected to (contract: `has_certificate` is port/subdomain
  → certificate; no url). For a url target testssl reports host →`resolves_to` ip →`has_port` port →
  `has_certificate` certificate, the same port node httpx and nmap make, so they merge. No contract change.
- **`--ip one`:** testssl tests one address of the host; the tested IP goes in the certificate's and each
  vulnerability's data; the README says a later run may pick another address behind a CDN.
- **wafw00f generic detection:** technology `generic-waf`, data `{waf: true, manufacturer: null, generic: true}`
  (evidence the analyst wants to see; `generic: true` marks it weak).
- **WAF fixture:** the lab plays a WAF (an nginx rule; no edited capture, no real target). One plain lab run (no WAF)
  too; the generic case is a unit test.
- **testssl on a port without TLS:** `failed`, "no TLS service on <port>"; closed/refused has its own message.
  Nothing ingested but the scan's provenance.

## Step 1: wafw00f

- **wafw00f 2.4.2** (2026-01-26, latest). Dependencies `requests` + `requests[socks]` (no pluginbase in 2.4).
  Resolved by pip inside the pinned Python image; each pinned to the newest release ≥ 2 weeks old: requests 2.34.2,
  urllib3 2.8.0, idna 3.20, **charset-normalizer 3.5.2** (3.5.3 is from 2026-11-23), **certifi 2026.10.23**
  (2026.11.20 is 4 days old), PySocks 1.7.1. `tools/http/wafw00f/requirements.txt`: exact versions + wheel sha256.
- **Image** (`tools/http/Dockerfile`): the fetch stage makes a venv `/opt/wafw00f` and runs `pip install --require-hashes
  --no-deps --only-binary :all: -r requirements.txt` (pip then uninstalled from the venv); the final stage copies the
  venv (same base image, same Python path).
- **Flags** (wafw00f 2.4.2's OptionParser, read in its source): `-r/--noredirect`, `-o - -f json` (JSON on stdout;
  wafw00f silences its own stdout, the log goes to stderr), `--no-colors`, `-T 10`. Not used: `-a -p -i -H -t -v -l`.
- **What wafw00f sends (source + lab log):** `waftoolsengine.Request` always does `requests.get(self.target,
  params=…)`: the `path` argument of its attack methods is **ignored**, so every request goes to the URL as given
  (its path included) plus a query string. Normal GET; one GET with XSS + SQLi + `../../etc/passwd` in random
  parameters (`identwaf`, signatures checked on its answer; first match wins) = **2 requests** on a match. Otherwise
  `genericdetect`: normal, no browser User-Agent (requests sends `python-requests/2.34.2`), XSS, a plain GET (the
  "lfi" one, path ignored), SQLi = **7 requests**. The xxe and command-injection strings exist but are never sent in
  this flow. Plugins make no requests of their own. `verify=False` (self-signed certificates are fine).
- **Down:** wafw00f logs "Site <host> appears to be down" (and "Something went wrong <requests error>") on stderr,
  prints `[]`, exit 0 → run.py: `failed`, with both texts.
- **Lab fake WAF** (`lab/nginx.conf`, `location = /waf/`; `lab/README.md`): `$args` matching encoded `<script`,
  `union+select`, `etc%2Fpasswd` → 403 with `<h1>403 Forbidden</h1>` + "Request forbidden by administrative rules."
  (the two things **Shadow Daemon (Zecure)**'s signature needs; neither names a vendor) and
  `X-RedWhale-Lab-Waf: blocked`; else 200. Only that path: `/` and every other e2e unchanged. Probed: `/waf/` →
  Shadow Daemon (2 requests), `/` and `http://…/` → no WAF (7 requests; the http:// 301 not followed).
- **Parser:** named WAF → `tech_value(firewall)` under the url (`uses_technology`), data `{waf, manufacturer}`
  (`Unknown`/`None` → null); `Generic` → `generic-waf` + `generic: true`; `detected: false` → nothing; a record for
  another URL (compared canonically) → error; `[]` → failed with the stderr reason.
- **Fixtures** (`tools/http/wafw00f/fixtures/`, NOTE.md): `raw.json` = the `/waf/` capture (`tools:check`),
  `no-waf.json` = the `/` capture; both real, anonymized to `lab.northwind.example`, nothing edited.
- **Tests:** `test_wafw00f.py` (15: argv, never `-a/-p/…`, non-http targets refused, tool.json, both fixtures,
  generic, tech_value spelling, unknown manufacturer, canonical URL compare, another URL, down with/without stderr,
  bad output). Server lists (`runner-docker`, `tools-fixtures` incl. "all 13 passed", `api/jobs`).
- **6C-6's full nuclei run #3** (started by the previous session) failed on a missing edge: my `pnpm lab:up` (for
  the `/waf/` rule) restarted the lab 37 minutes into it. Not a result. **Run #4** started 2026-11-24 23:31 with the
  lab untouched; its result goes into `docs/phase-6c6-progress.md`.

## Step 2: testssl.sh, group `tls`

- **testssl.sh v3.2.5** (2026-11-04; the newest stable, 20 days old; 3.3 is only dev snapshots). The release has no
  asset and no checksum: GitHub's source archive of the tag, sha256 `23bb53d5…d779` computed from the download
  (104 entries, no links). `fetch_release --tree`; Darwin/FreeBSD openssl builds removed; `testssl.sh` and
  `bin/openssl.Linux.x86_64` made executable (`--tree` writes 0644).
- **Image** (`tools/tls/Dockerfile`, group `tls` "TLS checks", `redwhale-tools/tls`): the pinned Python base (it has
  `/usr/bin/openssl` 3.5.9, testssl's second OpenSSL for TLS 1.3, plus bash, coreutils `timeout`, getent) + Debian
  packages, exact versions: `procps=2:4.0.4-9` (ps), `bsdextrautils=2.41.5-0+deb13u1` (hexdump),
  `bind9-dnsutils=1:9.20.30-1~deb13u1` (dig), `gawk=1:5.2.1-2+b1`. **No curl/wget/socat**: a second lock on
  `--phone-out`. testssl's own OpenSSL `1.0.2-bad` (bundled) via `--openssl`.
- **Flags** (all in `testssl.sh --help` of 3.2.5): `-p -s -S -U --jsonfile <tmp> --nodns min --ip one --warnings
  batch --color 0 --quiet --disable-rating --connect-timeout 10 --openssl-timeout 10`, `-6` for an IPv6 port target.
  `--version` is standalone (with other options: "Fatal error: --version is a standalone command line option").
- **DNS (probed with a logging `dig` shim first on PATH):** with `--nodns min` the only queries were
  `dig +search -r +short +timeout=2 +tries=2 -t a|aaaa lab.redwhale.test` (system resolver; `-r` ignores ~/.digrc).
  In the source: `min` skips PTR ("instructed to minimize DNS queries") and CAA ("check skipped as instructed"); MX
  only with `--mx`. `--nodns none` can't be used with `--ip one` (testssl refuses it).
- **Lab (url target), 49 s:** TLS 1.2+1.3, CBC offered, self-signed. LOW+: `cipherlist_OBSOLETED` (low),
  `cert_chain_of_trust` (critical), `cert_extlifeSpan` (medium, 825 > 398 days), `cert_revocation` (high),
  `LUCKY13` (low, `CVE-2013-0169`). `engine_problem` WARN ("No engine or GOST support") on every run: ignored.
  BREACH: "only supplied "/" tested" (one HTTP GET). DROWN prints a censys.io search link: text only, nothing fetched.
- **Port target** (`172.29.250.10:443`): same, plus `cmdline_ip-target` WARN ("results may be completely wrong, at
  minimum trust may show false results") and **`cert_trust` HIGH "certificate does not match supplied URI"**: an
  artifact of no hostname. **Decision (mine, tell the user): `cert_trust` is not reported on port targets** (kept in
  raw); on url targets it is.
- **Failures (probed):** `:8080` (plain HTTP) → `optimal_proto` WARN "doesn't seem to be a TLS/SSL enabled server",
  exit 245 → "no TLS service on 172.29.250.10:8080". `:9` → `scanProblem` FATAL "Can't connect …", exit 246 →
  "can't connect to …: closed, refused or filtered (…)". Unresolvable name with `--ip one` → FATAL "couldn't identify
  supplied 'CMDLINE_IP'" → "<host> did not resolve: no address through the system resolver". The specific reason
  replaces run_command's "exit code N" line; `failed`, no findings.
- **run.py**: `main(fetch=…)` (testssl's JSON is a file, stdout is the screen report): runs the command, returns the
  JSON file as raw. `needs_target_type` + `needs_resolvers`. `--checks a,b` (tests only, never in tool.json: subset
  of protocols, ciphers, defaults, vulnerabilities). An unclosed JSON list (killed at the time limit) is still read.
- **Findings:** url target: ip (parent only) →`has_port` `ip:port/tcp` (data `service: https`, like httpx) →`serves`
  url, and port →`has_certificate` certificate. **No host →`resolves_to` ip**: whether the url's host is a domain or a
  subdomain needs the Public Suffix List, which lives in the dns image; httpx/dnsx make that link and the port node
  merges with theirs. Port target: certificate and vulnerabilities under the port itself. Certificate data: subject
  (`cert_commonName`; testssl has no full subject), sans (list), issuer (`cert_caIssuers`), not_before/not_after
  (`YYYY-MM-DDTHH:MM:00Z`), trusted (`cert_chain_of_trust` OK), ip. Several certificates (`<hostCert#N>`): one node
  each; a vulnerability from one names it in `data.certificate`. Vulnerability data: id, finding (≤ 300), cwe, cves
  (when > 1), ip. Severity LOW/MEDIUM/HIGH/CRITICAL → low…critical.
- **Fixtures** (`tools/tls/testssl/fixtures/`, NOTE.md; all real, anonymized, nothing edited): `raw.json` (url,
  `tools:check`), `port.json`, `not-tls.json`, `closed.json`, `no-address.json`. The certificate fingerprint is the
  lab's, made at build (differs per machine).
- **Tests:** `test_testssl.py` (17: argv; never -h/STARTTLS/--phone-out/-c/-e…; port and IPv6 targets; refused
  targets; --checks; tool.json; url fixture (chain, certificate data, 5 vulns, severities, cwe); OK/INFO/WARN not
  findings; port target drops cert_trust; not-TLS, closed, no-address; two certificates; several CVEs; unclosed JSON;
  bad output; refused target). Server lists: group order puts `tls` before `urls`; "all 14 passed".
- `contacts` is capped at 300 characters by the tool.json schema: the probe list is shortened there (the README has
  the full one).

## Step 3: e2e

No lab change beyond step 1's `/waf/`. Both suites skip without Docker or the images; logs via `labLogSince`.

- **`server/test/wafw00f.e2e.test.ts`** (normal real-Docker suite, ~12 s): seeds the url, confirm required, then
  `confirmActive`; wafw00f's container is the address that sent the central attack (three random 8-letter
  parameters: the XSS, SQLi and `../../etc/passwd` strings).
  - `/waf/` → technology `shadow-daemon` (`uses_technology` from the url), data `{waf: true, manufacturer:
    "Zecure"}`; exactly 2 requests, both `GET /waf/…` to `lab.redwhale.test`, answered 200 then 403.
  - `/` → success, no findings; exactly 7 requests, all `GET /` or `GET /?…`, 4 with `python-requests/2.34.2`
    (after the generic detection drops the browser UA), 2 with the SLEEP string.
  - `http://` → success, no findings; every request answered 301, none to `elsewhere.redwhale.test`.
  - Every run: scan `success`, version 2.4.2, `-r` and `--no-colors`, never `-a`/`-p`.
- **`server/test/testssl.e2e.test.ts`**: testssl's lines in the lab log are the ones with its User-Agent
  (`TLS tester from https://testssl.sh/`). The lab's fingerprint is read from the running lab
  (`/etc/nginx/lab/cert.pem`, node's `X509Certificate`), never hard-coded.
  - fast (normal suite, `--checks protocols,defaults`): url target → ip →`has_port` `172.29.250.10:443/tcp` →`serves`
    url, →`has_certificate` the lab's fingerprint, data subject/issuer `lab.redwhale.test`, sans `[lab, elsewhere]`,
    trusted false, ip; `cert_chain_of_trust` critical, `cert_extlifeSpan` medium, `cert_revocation` high under the
    url; testssl's HTTP GETs (service detection) all `host=lab.redwhale.test`. Port target → certificate and
    `cert_chain_of_trust` under the port, no `cert_trust` node; its GETs carry `Host: 172.29.250.10`. `:8080` →
    scan `failed`, errors exactly `["no TLS service on 172.29.250.10:8080"]`, no testssl observation.
  - slow (`REDWHALE_E2E_SLOW=1`, the real tool.json): `-p -s -S -U`, exactly the 5 vulnerabilities
    (cipherlist_OBSOLETED low, cert_chain_of_trust critical, cert_extlifeSpan medium, cert_revocation high,
    CVE-2013-0169 low). **Run 2026-11-24: passed, 32 s, 2 HTTP requests from testssl** (service detection + BREACH),
    both to the lab.
  - Every run: `--nodns min`, `--ip one`, never `-h/--phone-out/-t/-c/-e`; nothing ever to `elsewhere` (a SAN of the
    lab's certificate: testssl must not contact it).
- e2e tests need their own timeouts (Vitest's default 5 s; the wait for a clean log window is 2.1 s, because the
  next container reuses the freed address and `--since` is whole seconds).
- Seen once in a full run: `tools-python > tools/urls/katana` timed out (5 s default) under the e2e load; passes
  alone and on the next full run. Not touched by this phase.

## Step 4: docs

- `docs/architecture.md` §11 (lab `/waf/`; wafw00f in `http`; the `tls` group) and §13 (9 rows: no contract change;
  wafw00f pin and flags; wafw00f findings; the lab WAF fixture; testssl image and flags; DNS and `--ip one`; testssl
  findings incl. port targets without `cert_trust` and no `resolves_to`; failures; e2e).
- `tools/http/README.md` (wafw00f section, updating), new `tools/tls/README.md`, `lab/README.md` (`/waf/` row; what
  testssl reports on the https server), `docs/team-guide.md` (2 rows: a PyPI tool with one JSON array; a tool that
  writes a JSON file, `main(fetch=…)`), `docs/handoff.md` (status row, key decisions, batch list, merge order and
  rebuild).
- **Not done:** ALL TOOLS GUIDE.pdf (its generator isn't in the repo; not in this phase's step list).

## Manual check (PowerShell, from the repo root)

**Setup** (proves: both images build from pinned sources; fixtures replay):

1. `git switch phase-6c7`, then `pnpm install`.
2. `pnpm tools:build http`, then `pnpm tools:build tls`: the http log shows pip installing exactly the 7 pinned wheels
   (`--require-hashes`); the tls log shows `ok 94 files from testssl.sh-3.2.5 … sha256 of archive 23bb53d5…` and the
   4 Debian packages at their pinned versions. (After merging everything: `pnpm tools:build`, all groups.)
3. `pnpm lab:up` (rebuilds the lab: nginx.conf changed). `pnpm tools:check --all`: `✓ all 14 passed`.
4. `pnpm dev`, open http://127.0.0.1:5173. Right-click a **url** node ▸ Run tool lists **wafw00f** (in HTTP
   probing) and **testssl.sh** (Run group: **TLS checks**); a **port** node lists testssl.sh (and nmap); no red circles.

**wafw00f against the lab** (proves: confirmation, the WAF finding, no finding without a WAF):

5. Scope panel: `include domain lab.redwhale.test`, `include ip 172.29.250.10`; passive-only **off**.
6. Add node ▸ url `https://lab.redwhale.test/waf/`. Right-click it ▸ **wafw00f**: the dialog shows ACTIVE, "Contacts
   the target: 2 to 7 HTTP GET requests to https://lab.redwhale.test/waf/: …attack-looking test strings…; redirects
   are not followed", External services: none, **In scope**. Run it: a few seconds.
7. Under `/waf/`: technology **shadow-daemon** (its observation: `waf: true`, `manufacturer: Zecure`).
8. Run wafw00f on `https://lab.redwhale.test/` (add the node if missing): job **succeeded**, scan success, **no new
   node**.
9. `docker logs redwhale-lab --since 5m | Select-String "waf/"`: two lines for step 6 (200, then 403 with
   `%3Cscript%3E…` in the query string); nothing for `elsewhere`.

**testssl against the lab** (proves: the port chain, the certificate, the vulnerabilities, failures):

10. Right-click `https://lab.redwhale.test/` ▸ **testssl.sh**: the dialog shows ACTIVE and the TLS handshake text
    (one address, system resolver, Heartbleed … RC4, one GET for BREACH, no other host). Run it: under a minute.
11. Graph: `172.29.250.10` ▸ `172.29.250.10:443/tcp` (same node httpx makes, if you ran it) ▸ a **certificate** (its
    observation: subject and issuer `lab.redwhale.test`, sans `lab` + `elsewhere`, `trusted: false`, not_after in
    2029, ip); the port ▸ `serves` the url. Under the url: **cert_chain_of_trust** (critical), **cert_revocation**
    (high), **cert_extlifeSpan** (medium), **cipherlist_OBSOLETED** and **CVE-2013-0169** (low; data `id: LUCKY13`).
12. Right-click the port `172.29.250.10:443/tcp` ▸ testssl.sh: the same certificate (one node, now two
    observations) and vulnerabilities under the port; **no `cert_trust`**.
13. Add node ▸ port `172.29.250.10:8080/tcp` (under ip `172.29.250.10`) ▸ testssl.sh: job's scan **failed**, error
    "no TLS service on 172.29.250.10:8080", no new node.
14. `docker logs redwhale-lab --since 10m | Select-String "TLS tester"`: only `host=lab.redwhale.test` or
    `host=172.29.250.10`, `GET /`; nothing for `elsewhere` (a SAN of the certificate).

**A real target** (only one you are authorized to test, and only if its program allows active scans):

15. wafw00f on its `https://` url: a CDN/WAF shows as technology (e.g. `cloudflare`, merging with httpx's). testssl on
    the same url: the certificate is trusted (`trusted: true`), with the real SANs in its data; the tested `ip` is one
    of the host's addresses.

## Manual checks of 6C-4 … 6C-7 (run by Claude on `phase-6c7`'s tip, 2026-11-28)

The user asked Claude to run the six checklists. Done on a **scratch database** (API on 4101, UI on 5174, the user's
own `pnpm dev` on 4100/5173 untouched); the user's real database only **read** (GET requests), never written.

- **Setup:** `pnpm install` stopped on ERR_PNPM_IGNORED_BUILDS (dockerode's optional ssh2/cpu-features/protobufjs
  scripts): fixed by denying them in `pnpm-workspace.yaml`. `tools:build` all 7 current, `tools:check --all` 14
  passed, typecheck, `pnpm test` (with Docker) green after fixing a wafw00f e2e log filter (an address reused by
  another suite's container).
- **6C-4:** all steps pass (nmap dialog text, 4 ports with data, `tunnel ssl`, OpenSSH 9.6p1, the exact command,
  banner + version-script lines in the lab log, `-p 22` on a port, the refusal without nmap, httpx corroborates
  nginx, scope removal → out ("judged by its IP") and a confirmed run refused, 428 with no log entry, naabu
  corroborates :22, lab down/up) **except step 19**: `pnpm mock` refused a workspace with lab port scans (their
  target is the lab's IP). **Fixed** (user: the lab's address is disposable; §13 2026-11-28).
- **TW-1:** steps 3, 5 (showcase `cname_to` by dnsx), 15 (no-resolver refusal) pass; step 4 (the real database opens
  on the current schema with its data) passes, read-only; step 6 is covered by `add-node-dialog.test.tsx` (the canvas
  kept moving under clicks). **Steps 7–14 need a real authorized subdomain: left to the user.**
- **TW-2** (a 30-subdomain mock): auto jobs at most 2 running / 10 queued, refilling, AUTO badge; a manual job starts
  before 7 older queued auto jobs; switching auto off cancels the queued ones ("auto takeover checks were turned
  off") and on refills them; after a restart no new auto job for checked subdomains; `REDWHALE_AUTO_MAX_QUEUED=3`
  caps at 3; an excluded subdomain never gets a job or a scope-log `run` entry; exclude rule keeps status and date;
  a manual re-check moves Last checked; the row click selects the subdomain and opens its group. On the **real**
  database, read-only: status order and days-left order hold (165 ok rows, 142–1,728 days), chain end = last CNAME,
  3 rows with several domains for the tooltip, external names hidden by default (11 graph/table nodes, 6 watch rows)
  and back with `showExternal=1`. Not seen live: "checking…" (the `pending` field is there).
- **6C-5:** katana dialog text, the url tree exactly as listed, `http://` 301 corroborated, no `elsewhere`, 11 GETs
  all to the lab with none of the excluded files, the command's flags, the refusal without the network: all pass.
  **gau (steps 13–15) needs a real domain: left to the user.**
- **6C-6:** the url's Run tool menu lists the four groups and nuclei, no red circles. The 40-minute lab scan (steps
  5–10) not repeated: the slow e2e run #6 (2026-11-25) checked the same findings, masking and lab log. **Step 11 (a
  real target) left to the user.**
- **6C-7:** wafw00f dialog text, `shadow-daemon` (Zecure) under `/waf/`, none under `/`, the `/waf/` lab lines;
  testssl: the port chain, one certificate node with two observations (url and port runs), the 5 vulnerabilities
  under url and port, no `cert_trust`, `:8080` → "no TLS service on 172.29.250.10:8080", testssl's GETs only to the
  lab; its contacts text checked through `/api/tools` (the canvas moved under the click). **Step 15 (a real target)
  left to the user.**

## Next action

The user's real-target steps (TW-1 7–14, 6C-5 13–15, 6C-6 11, 6C-7 15), then the merges (`--no-ff`, one phase at a
time: 6c4, tw1, tw2, 6c5, 6c6, 6c7). Then `pnpm tools:build` and `pnpm lab:up`.
