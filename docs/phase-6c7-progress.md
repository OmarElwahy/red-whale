# Phase 6C-7 progress: WAF detection (wafw00f) and TLS checks (testssl.sh)

Branch `phase-6c7`, cut from `phase-6c6` (`feb293a`). Started 2026-11-24.

**Goal:** wafw00f (WAF detection) and testssl.sh (TLS checks), both active, findings on the graph.

**Not in scope:** certificate SANs as subdomain findings (later); testssl's HTTP header checks (`-h`), STARTTLS,
`--phone-out` (OCSP/CRL lookups); wafw00f `-a` (every signature); any WAF bypass.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | wafw00f in `http` (pin, tool.json, run.py, lab fake WAF, fixtures, tests) | done |
| 2 | `tls` group + testssl (Dockerfile, flags checked, tool.json, run.py, certificate/vuln parser, tests) | |
| 3 | e2e (wafw00f; testssl fast + slow), results recorded here | |
| 4 | Docs (§11/§13, group READMEs, team-guide rows, handoff) + manual checklist | |

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

## Next action

Step 2: `tls` group. Pick the testssl.sh release (newest ≥ 2 weeks old), sha256 of its tarball, Dockerfile with its
Debian dependencies, check `--help` for every flag (`-p -s -S -U --jsonfile --nodns min --ip one --warnings batch`),
probe `--nodns min` under `--network none`. Don't restart the lab while nuclei run #4 is going.
