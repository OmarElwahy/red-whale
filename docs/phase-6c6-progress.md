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
| 3 | e2e against the lab (fast every step; full scan gated on `REDWHALE_E2E_SLOW=1`) | |
| 4 | Docs (§11/§13, tools/vuln/README, team-guide row, handoff) + manual checklist | |

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

## Next action

Step 3: `server/test/nuclei.e2e.test.ts` (fast: `--template-ids git-config,laravel-env,nginx-version,php-detect` in the normal real-Docker suite; full scan with `REDWHALE_E2E_SLOW=1`, run once and recorded here).
