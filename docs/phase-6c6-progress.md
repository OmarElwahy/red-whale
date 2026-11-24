# Phase 6C-6 progress: vulnerability scanning (nuclei)

Branch `phase-6c6`, cut from `phase-6c5` (`e52258d`). Started 2026-11-24.

**Goal:** a new tool group `vuln` ("Vulnerability scanning") with nuclei: active, accepts `url`, findings on the graph.

**Not in scope:** wafw00f/testssl; custom templates; DAST/fuzzing; headless, code, file, javascript protocols;
authenticated scans; auto-running after httpx/katana (6D); deciding the intrusive-tools question.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | `vuln` group image: Dockerfile (nuclei + pinned templates), flags checked, template count | done |
| 2 | Lab files + nuclei tool.json/run.py/parser, lab fixture, tests | done |
| 3 | e2e against the lab (fast every step; full scan gated on `REDWHALE_E2E_SLOW=1`) + what it found | done (full run #3 pending) |
| 4 | Docs (§11/§13, tools/vuln/README, team-guide row, handoff, ALL TOOLS GUIDE.pdf) + manual checklist | done |

## Decisions (from the plan review)

- HTTP templates only: `-t /opt/nuclei-templates/http/ -pt http`. TLS is testssl's (later); dns/network templates
  would contact things outside the URL.
- Extracted values are masked (`mask_secret`) in vulnerability findings; technology findings keep theirs (versions).
  raw.txt is **not** redacted: it is the evidence (provenance), stays local under data/jobs, and fixtures are lab fakes.
- The matched URL gets its own `url` node (target `--has_url-->` it), with the vulnerability under it; no extra node
  when matched-at is the target itself.
- One finding per vulnerability value + URL: two matchers of one template merge, `data.matcher` a sorted list.
- **Time budget (answer to step 1): A.** `timeoutSec` 3600, nuclei's own `-mt 55m`; 5/s and the full coverage kept.
- **Excluded tags also `ssrf,oast,proxy`** (answer to step 1): templates that make the target fetch a hard-coded
  outside host. Template count 6,900 → **6,516** loaded ("Templates loaded for current scan").
- e2e: a fast one in the normal real-Docker suite (`-id` with the 2-3 templates that should fire), and the full scan
  only with `REDWHALE_E2E_SLOW=1` (run once in step 3; time, request count and findings recorded here).

## Step 1: image

- **nuclei v3.11.1** (2026-08-08, latest release): `nuclei_3.11.1_linux_amd64.zip`, sha256 `ea63d4ae…5ab6` from the
  release's checksums.txt.
- **nuclei-templates v10.5.1** (2026-10-23; v10.5.2 of 2026-11-12 is under 2 weeks old): GitHub's source archive of
  the tag, sha256 `30fe1cfa…56eb`, which is the `nuclei-templates-10.5.1.tar.gz` line in the release's
  `nuclei-templates-10.5.1_checksums.txt` (downloaded and compared). The release has no other asset. GitHub doesn't
  promise source-archive bytes never change; if they do, the build fails on the checksum (never different content).
- `fetch_release.py --tree <url> <sha256> <top folder> <dest>`: extracts a whole tree; refuses the archive on any
  entry outside the top folder, absolute, with `..` or `\`, or not a regular file/folder (no links, devices, FIFOs).
  Tests: `tools/lib/test_fetch_release.py`. The 10.5.1 archive has 15,395 entries, no links; 11,718 http templates.
- **Config folder** `/opt/nuclei-config` (`NUCLEI_CONFIG_DIR`), root-owned, read-only at run time. nuclei refuses to
  start on a read-only config folder unless `config.yaml` and `reporting-config.yaml` exist ("could not create config
  file"); empty files are enough. `.nuclei-ignore` is copied from the templates (it is read only from the config
  folder): without it the default ignore list (tags dos, local, fuzz, bruteforce, txt-service and some weak-matcher
  templates) is skipped ("Could not read nuclei-ignore file"). `.templates-config.json` names /opt/nuclei-templates.
  nuclei never runs at build time.
- `DISABLE_NUCLEI_TEMPLATES_{PUBLIC,GITHUB,GITLAB,AWS,AZURE}_DOWNLOAD=true` in the image (second lock after -duc).
- **Flags** (all in `nuclei -h` of v3.11.1): `-u -t -pt http -tags -etags -ni -dr -duc -or -rl -c -retries -timeout
  -jsonl -silent -nc -r -id -tl`, and **`-mt/-max-time`** (e.g. `30m`): nuclei can stop itself before the job's limit.
  Not used: `-fr`, `-headless`, `-code`, `-dast`, `-lfa`, `-ev`, `-pd/-dashboard`, `-pdu`, `-stats`, `-uc`, `-sresp`.
- **No outside contact (probed)**: with `--network none`, read-only root, user 10001, `-v`: "remove '-duc' flag to
  enable update checks" (engine and templates), "Scan results upload to cloud is disabled", templates from
  /opt/nuclei-templates, no download attempt or network error other than the target. `-v` also shows "Started metrics
  server at localhost:9092": inside the container only, nothing outside.
- **Template count:** 6,900 with `-t …/http/ -pt http -tags cve,misconfig,exposure,tech,takeover -etags
  intrusive,dos,fuzz,bruteforce,default-login,osint -ni -dr` and the ignore list (6,902 without it).
- **Requests (measured):** one full scan of the lab (`https://lab.redwhale.test/`, at nuclei's default speed for the
  count only) sent **11,031 requests** in 81 s and returned 15 results. At 5/s that is ~2,206 s (**~37 min**), over
  the 1800 s budget (~9,000 requests at 5/s). Asked the user before step 2 (answer: A, and exclude ssrf,oast,proxy).
- **Host headers (measured):** every request went to the lab (its access log has them all), but 34 carried another
  name in the Host header: 169.254.169.254 (7), 100.100.100.200 (2), aws.oast.online (7), alibaba.oast.pro (2),
  oast.me, interact.sh, 169.254.169.254.nip.io, localhost (2), random `.tld`/`.com`/`.invalid` names. These are
  SSRF / host-header templates with hard-coded OAST hosts that `-ni` doesn't exclude (they don't use
  `{{interactsh-url}}`). Nuclei itself contacted only the target, but a vulnerable proxy on a real target could fetch
  those names. No `elsewhere.redwhale.test`. 747 requests got nginx's 400 (path traversal), logged as host `_`.
- Results of the measuring scan: php-detect (`8.3.12`), nginx-version (`nginx/1.30.6`), tech-detect (nginx, php),
  waf-detect (`nginxgeneric`, tags waf,tech), http-missing-security-headers (10 matchers).

## Step 2: lab files, nuclei tool, fixture, tests

- **Lab** (`lab/nginx.conf`, `lab/README.md`): `https://lab.redwhale.test/.git/config` and `/.env`, `text/plain`,
  served by nginx `location` blocks (git never tracks a path named `.git`, so they can't be files in `lab/site/`).
  Obviously fake: a git config whose remote URL has `redwhale-lab:fake-not-a-secret@git.redwhale.test`, and a
  Laravel-style `.env` (`APP_*`, `DB_*`, values `redwhale-lab-fake-…`). Linked from nowhere (katana's e2e unchanged).
  `laravel-env` needs a non-HTML content type (the lab's default is text/html).
- **Requests with the final tags (measured):** 10,826 requests in 79 s at nuclei's default speed (count only), all
  to the lab. ~36 min at 5/s, inside `-mt 55m`. Contacts text: "about 11,000 HTTP requests". Still another name in
  the Host header in 7 requests: `interact.sh`, random `<x>.tld`/`<x>.com` (Host-header open-redirect checks:
  CVE-2019-1943, CVE-2021-22881, …) and `localhost` (403-bypass / CVE-2022-1388). The target only answers them; none
  makes it fetch anything. Noted for the intrusive question (out of scope): the `cve` set has state-changing checks
  not tagged intrusive (e.g. CVE-2022-1388 `POST /mgmt/tm/util/bash`; `rce`, `file-upload` tags).
- **`run.py`** (tools/vuln/nuclei): `build_command(target, template_ids=())`. Probes behind the choices:
  - `-r` takes **only a file** ("Could not open resolvers file: open 127.0.0.11:53"): the script writes the machine's
    resolvers to `/tmp/redwhale-nuclei-resolvers.txt`. With a bogus resolver in it, nuclei resolved nothing (no
    fallback to public DNS).
  - **No `-silent`**: with it, a host skipped as unresponsive and the `-mt` stop leave nothing on stderr. Without it
    (stdout stays pure JSON lines): "Skipped <host> from target list as found unresponsive", "CTRL+C pressed: Exiting"
    (the -mt stop, no "Scan completed"), "Templates loaded for current scan: N". `check_log` turns those into errors
    (job `partial`). For that, `ToolRun.run_command` now keeps the tool's stderr in `run.stderr` (None on replay).
  - `-ot` (omit the encoded template) as well as `-or`: raw.txt stays small.
  - `-u` gets the target **without its trailing `/`** (`scan_url`): templates that add a path from a payload
    (`{{BaseURL}}{{paths}}`, laravel-env) otherwise requested `https://host//.env`.
  - `--template-ids a,b` (tests only, never in tool.json): `-id`. nuclei ANDs it with the tag filters (probed: an
    `ssrf` template and an off-tag panel template named in `-id` were not loaded), so it only narrows. IDs are checked
    (`[A-Za-z0-9][A-Za-z0-9_.-]*`, at most 20).
- **Parser decisions:**
  - `tech` tag → `technology` unless the template also has a CVE or the `waf` tag (`waf-detect` → vulnerability, its
    matchers are WAF rule sets like `nginxgeneric`). Name: an extracted `name/version`, else the matcher name (unless
    generic like `version`), else the template ID without `-detect`/`-version`/…; version only if it looks like one;
    spelled by `tech_value` (`php/8.3.12`, `nginx/1.30.6` match httpx and nmap). A bare name is dropped when the
    same URL has it with a version (`tech-detect`'s `nginx` beside `nginx-version`'s `nginx/1.30.6`).
  - Vulnerability value: the first CVE ID (sorted, uppercased; all of them in `data.cves` when more than one), else
    the template ID. data: template, name, matched_at, matcher (sorted list), extracted (masked, ≤ 5), cvss (score),
    references (≤ 5), tags; `cves` when several.
  - **Dot segments**: a matched-at path with `.`/`..` segments (also `%2e`) hangs off the target, `matched_at` kept as
    requested. The server stores URLs as WHATWG spells them, which resolves them
    (`/cgi-bin/.%2e/.%2e/etc/passwd` → `/etc/passwd`): a misleading url node.
  - `canonical_url` moved from `tools/urls/urls_common.py` to `tools/lib/redwhale_tool.py` (re-exported there): an
    image's build context is lib + its own folder only. lib changed anyway in step 1, so **every tool image is
    outdated: `pnpm tools:build` (all groups) after this phase.**
- **Image config** (`NUCLEI_CONFIG_DIR`) as in step 1; the `vuln` group is `redwhale-tools/vuln`.
- **Fixture**: real capture against the lab with 8 template IDs (18 lines, 49 requests, 11 s), 2 edited lines (a CVE
  with dot segments; another host). `tools/vuln/nuclei/fixtures/NOTE.md`. Expected: 10 findings, success.
- **Tests**: `test_nuclei.py` (26: argv always `-ni -dr -duc` and every excluded tag, never `-fr -headless -code
  -dast -silent …`, rate/time flags, resolver file, template-id checks, tool.json never passes them; severity map;
  CVE vs template ID; dedupe + matcher list; masking; tech vs vuln; bare-name drop; url node; another host; dot
  segments; stderr checks); lib: `test_fetch_release.py`, `ToolRun.stderr`. Server lists of groups/tools updated
  (`runner-docker`, `tools-fixtures`, `api/jobs`).

## Step 3: e2e, and what the full runs found

- **`server/test/nuclei.e2e.test.ts`**, three tests:
  - **template set** (vuln image only, `--network none`): pipes `server/test/nuclei_template_set.py` into the image.
    It lists what run.py's own command loads (`-tl`) and reads every template: none with an excluded tag, none of
    the excluded IDs, **none that connects to another port** (`{{Hostname}}:<port>`) **or another host** (`@Host:` in
    a raw request, a literal URL in a path or request line), HTTP only, `.nuclei-ignore` honoured. -tl lists 6,495.
  - **fast** (normal real-Docker suite, ~20 s): the repo catalog with nuclei's argv + `--template-ids
    git-config,laravel-env,nginx-version,php-detect`, through the orchestrator (confirm required, then
    `confirmActive`), ingest: url `/.git/config` and `/.env` under the target; `git-config` (medium) and
    `laravel-env` (high) under them; `nginx/1.30.6` corroborated (stand-in httpx seed), `php/8.3.12` discovered, no
    bare `nginx`; the fake credential nowhere in the DB (observations, nodes, scans.raw), present in raw.txt; the
    command has `-ni -dr -duc -or`, every excluded tag, `-eid`, `-u` without the trailing `/`; status success,
    version 3.11.1; no excluded tag on any result; nuclei's access-log lines (its container's address, the one that
    fetched `/.git/config`) all `host=lab.redwhale.test`, all GET, 20–40 of them, no OAST host.
  - **slow** (`REDWHALE_E2E_SLOW=1`, ~38 min): the real catalog, the same checks plus generic-env,
    http-missing-security-headers (10 matchers), waf-detect, no request from the interactsh-only templates
    (`/backupmgt/`, `/plugins/servlet/jwd/amf`), Host header values only the lab, `_`, `localhost`, `interact.sh` or
    random `.tld`/`.com`/`.invalid` names, > 9,000 requests.
  - Lab logs are read with `docker logs --since` (spawnSync): `runtime.logs` keeps the first 4 MB, and a full scan
    writes ~2.3 MB on top of what the lab already logged.
- **Full run #1** (2,294 s): failed on status `partial`: "nuclei skipped lab.redwhale.test:5814 as unresponsive".
  5 templates connect to a fixed **other port** of the host (4040 CVE-2018-8024, 6066 CVE-2020-9480, 43800
  CVE-2024-6396, 9780 CVE-2025-52665, 5814 hpe-autopass-panel). Fixes: `check_log` treats only the target's own
  host:port as incomplete (a side port is logged); **user: exclude the 5** (`-eid`, `SIDE_PORT_IDS`).
- **Full run #2**: everything up to the access-log checks passed (status success, findings, masking, flags); it
  failed on my own assertion "no OAST host in the log": the full set's open-redirect checks name oast.me /
  interactsh.com in a parameter (75 lines, all to the lab; harmless with `-dr`, kept by design). That assertion is now
  in the fast test only.
- **The user's first real scan** (job 202, a real target's `http://` url, 38 min, success, 5 matches) showed
  `azure-domain-tenant` matched at `https://login.microsoftonline.com/<domain>/…`: **nuclei had contacted Microsoft**
  (an `@Host:` annotation moves the connection). The parser ignored the result (another host), but the request went
  out. The lab e2e could not see it (the tools network has internet; the lab only logs its own requests). A scan of
  all loaded templates found **18 that connect to another host**: 15 token checks that send a token found on the
  target to its service's API (api.github.com, slack.com, api.stripe.com, api.telegram.org, ...), azure-domain-tenant,
  intercom-identity-misconfiguration (api-iam.intercom.io) and nginx-status-403-bypass (`@Host: localhost`, the
  container). All excluded (`OUTSIDE_HOST_IDS`): this is the phase's rule ("no outside contact except the target"),
  not a new decision. The template-set test now fails on any new one. 23 IDs in `-eid` in all.
- The job's other findings: cookies-without-secure (low), missing-cookie-samesite-strict, waf-detect (Cloudflare),
  technology `cloudflare` (corroborated with httpx). `http://` most likely only redirects (Cloudflare); the
  `https://` url node is the one to scan.
- **Every tool image was outdated** after step 2 (tools/lib changed) and the user's UI blocked every run (red
  circle): rebuilt all groups (`pnpm tools:build`), then `vuln` after each run.py change; `/api/runner/status` all
  `built`.
- **Lab log reads** (`server/test/lab-log.ts`, used by the httpx, katana and nuclei e2e): `docker logs --since`. Once every image was current, the httpx and katana e2e ran again and failed: they read `runtime.logs`, which keeps the FIRST 4 MB, and the lab's log had grown to 7.1 MB with the nuclei runs, so their own lines were cut.
- **Full run #3** (with the 23 exclusions): running at commit time; its time, request count and findings go here.

## Step 4: docs

- `docs/architecture.md` §11 (lab files; the `vuln` group) and §13 (7 rows: no contract change; versions and config
  folder; template set with ssrf/oast/proxy and the 23 `-eid`; time budget; run.py; findings; e2e).
- `tools/vuln/README.md` (image, command, outside contact, findings, updating the templates); `docs/team-guide.md`
  (a row for an active scanner with its own data); `docs/handoff.md` (status row, key decisions, batch list, open
  items: rebuild all images after merging, the intrusive question).
- **ALL TOOLS GUIDE.pdf** regenerated (21 pages, was 18): cover/footer 12 tools, 6 groups, 5 active, phase-6c6; a
  3.12 nuclei section; section 4 now describes nuclei's templates; nuclei in the overview, groups, run order,
  relations and lab tables. Its generator script (ReportLab) is not in the repo: it was found in an old scratchpad.

## Manual check (PowerShell, from the repo root)

**Setup** (proves: the image builds from pinned archives; every image is current; fixtures replay):

1. `git switch phase-6c6`, then `pnpm install`.
2. `pnpm tools:build`: every group builds; for vuln the log shows `ok nuclei (…)` and `ok <n> files from
   nuclei-templates-10.5.1 to /dist/nuclei-templates`, each with its archive's sha256. (C: needs a few GB free.)
3. `pnpm lab:up` (rebuilds the lab: nginx.conf changed). `pnpm tools:check --all`: `✓ all 12 passed`.
4. `pnpm dev`, open http://127.0.0.1:5173. Right-click a **url** node ▸ Run tool lists **Run group: Vulnerability
   scanning** and **nuclei**; on a domain or subdomain they are not listed (nuclei accepts url only). No red circles.

**nuclei against the lab, active** (proves: confirmation, findings, masking, corroboration, no outside contact):

5. Scope panel: `include domain lab.redwhale.test`, `include ip 172.29.250.10`; passive-only **off**.
6. Subdomain `lab.redwhale.test` ▸ httpx (adds `https://lab.redwhale.test/` and `nginx/1.30.6`).
7. Right-click `https://lab.redwhale.test/` ▸ **nuclei**: the dialog shows ACTIVE, "Contacts the target: about 11,000
   HTTP requests to https://lab.redwhale.test/'s host for known CVEs, …; no out-of-band callbacks; redirects are not
   followed", "External services: none", **In scope**. Run it: about 36–40 minutes.
8. Under `https://lab.redwhale.test/`: url `/.git/config` with vulnerability **git-config** (medium; its observation
   `extracted ["redw****cret"]`), url `/.env` with **laravel-env**, **generic-env** (high), and the target itself has
   **http-missing-security-headers** (`matcher` lists 10 headers), **waf-detect**, technologies `nginx/1.30.6`
   (**corroborated**: httpx and nuclei) and `php/8.3.12`. No node `nginx` without a version; nothing on `elsewhere`.
9. The job's raw output (job panel ▸ raw) still has `fake-not-a-secret` (the evidence); no node or observation does.
10. `docker logs redwhale-lab --since 45m | Select-String -NotMatch "host=lab.redwhale.test "`: only `host=_` (400s),
    `host=localhost`, `host=interact.sh` and random `.tld` lines (Host-header checks); **no** `elsewhere`.

**A real target** (only one you are authorized to test):

11. Run nuclei on its **https://** url node (not `http://`, which often only redirects). The job's stderr (job panel)
    ends with "Scan completed in …" and "Templates loaded for current scan: ~6,49x"; no result names another host
    (before this phase's fix, azure-domain-tenant contacted login.microsoftonline.com).

## Next action

Record full run #3's result here (scratchpad slow-e2e-3.txt: `[nuclei slow e2e] <s> s, <n> requests, …`); if it fails, fix and re-run `REDWHALE_E2E_SLOW=1 pnpm vitest run server/test/nuclei.e2e.test.ts -t slow`. Then the phase is done: the user's manual check above, then merge (6C-5 first).
