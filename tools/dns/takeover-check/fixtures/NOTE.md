# takeover-check fixtures

Each `raw.json` is a takeover-check **transcript**: every DNS (dnsx), RDAP and WHOIS exchange of one run, plus the
RDAP bootstrap entries the run used (`bootstrap`) and the bundled data's versions (`data`). `--replay` answers from it
with no network. `pnpm tools:check takeover-check` replays `fixtures/raw.json` (case 3); `test_takeover_check.py`
replays the seven case folders against their `expected.json` the same way.

All exchanges were captured on 2026-11-22 with the tool's own code (`run.py`, `LiveNet`) inside the
`redwhale-tools/dns` image, as user 10001, read-only root, no capabilities, on the `redwhale-tools` network (Docker's
resolver `127.0.0.11`): dnsx v1.3.1, whois 5.6.3, RDAP over HTTPS (Verisign, Nominet for `.microsoft`). The data was
PSL `2026-11-21_04-33-45_UTC` and the RDAP bootstrap of `2026-11-20T23:00:03Z`.

## Anonymized (every file)

- The real target domain → `northwind.example`; the target company's server domain (where `ftp`'s chain ends) →
  `northwind-servers.example`. Both bootstrap `entry` values `com` → `example` (the server URL is kept, so replay
  takes the same path).
- In those two domains' RDAP records: the registry handles (`1000001_…`, `1000002_DOMAIN_EXAMPLE-VRSN`), the registrar
  (name, IANA ID, URLs, abuse e-mail and phone → `Example Registrar, Inc.`, `9999`, `registrar.example`), the
  registration / expiry / last-changed dates (moved to made-up dates) and the nameservers (→ `NS1`/`NS2.NORTHWIND.EXAMPLE`).
- Every IP address in dnsx's answers → `198.18.0.10`–`198.18.0.20` (consistently; Docker's `127.0.0.11` and the
  TEST-NET address `192.0.2.1` are kept).
- **Kept as they are:** well-known third-party service names and their public registry records (Microsoft 365:
  `outlook.com`, `cloud.microsoft`, `office.com`; `azurewebsites.net`; `statuspage.io`). They say nothing about the
  target, and the Public Suffix List behaviour depends on the real names (`cloud.microsoft` is a TLD,
  `azurewebsites.net` a private suffix). Names under them that start with `redwhale-` were made up for the capture.

## Cases

| Folder | Case | Real or edited |
|---|---|---|
| `raw.json` (main) | 3. CNAME to external registered domains: `autodiscover.northwind.example` → Microsoft 365 (4 hops, `outlook.com`, `cloud.microsoft`, `office.com`), each with expiry | real run |
| `1-no-cname/` | 1. No CNAME: `www.northwind.example`; only its own domain is looked up | real run |
| `2-internal-cname/` | 2. CNAME inside the target's domain: `ftp` → `prod1ftp` → `prod1ftp-lb.northwind-servers.example` | real run |
| `4-unregistered/` | 4. CNAME to an unregistered domain: `assets.northwind.example` → `redwhale-unreg-7q2x.com` (critical) | **edited**: the target's CNAME line. Real: the NXDOMAIN answers and the RDAP **404** for `redwhale-unreg-7q2x.com` (a made-up name, not registered on 2026-11-22) |
| `5-dangling-service/` | 5. Dangling CNAME to a cloud service: `shop.northwind.example` → `redwhale-gone-7q2x.azurewebsites.net` (medium) | **edited**: the target's CNAME line. Real: the NXDOMAIN for that made-up Azure name |
| `6-loop/` | 6. CNAME loop: `loop` → `loop2` → `loop` | **edited**: both CNAME lines (copies of a real dnsx line from case 2, names and timestamps changed) |
| `7-whois-fallback/` | 7. TLD with no RDAP: `status.northwind.example` → `redwhale-x7q2.statuspage.io`; `statuspage.io` via WHOIS | **edited**: the target's CNAME line. Real: dnsx's answers for the made-up name (Statuspage answers any name), the bootstrap's "no service" for `io`, and the whois output for `statuspage.io` |
| `8-rdap-timeout/` | 8. RDAP timeout: `cdn.northwind.example` → `edge.partner-assets.example`, whose registration is unknown | **edited**: both CNAME lines, the end-of-chain answer (case 7's real line, name changed), and the bootstrap entry for `partner-assets.example` (→ `https://192.0.2.1/`, TEST-NET-1). Real: the RDAP exchange, a timeout on all three tries against `192.0.2.1` (domain in the URL renamed) |

In cases 4 to 8 the RDAP exchange for `northwind.example` is a copy of case 3's (anonymized) record.

`expected.json` in each folder is what `run.py --replay` must produce from its `raw.json` (`target_type`
`subdomain`); regenerate the main one with `pnpm tools:check takeover-check --update` and the case folders with
`$env:REDWHALE_UPDATE_FIXTURES = "1"` before running `test_takeover_check.py` (then remove it), and **read them**.
