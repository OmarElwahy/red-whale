# Phase 6C-6 progress: vulnerability scanning (nuclei)

Branch `phase-6c6`, cut from `phase-6c5` (`e52258d`). Started 2026-11-24.

**Goal:** a new tool group `vuln` ("Vulnerability scanning") with nuclei: active, accepts `url`, findings on the graph.

**Not in scope:** wafw00f/testssl; custom templates; DAST/fuzzing; headless, code, file, javascript protocols;
authenticated scans; auto-running after httpx/katana (6D); deciding the intrusive-tools question.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | `vuln` group image: Dockerfile (nuclei + pinned templates), flags checked, template count | done |
| 2 | Lab files + nuclei tool.json/run.py/parser, lab fixture, tests | waiting on the time-budget decision |
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
  the 1800 s budget (~9,000 requests at 5/s). Asked the user before step 2.
- **Host headers (measured):** every request went to the lab (its access log has them all), but 34 carried another
  name in the Host header: 169.254.169.254 (7), 100.100.100.200 (2), aws.oast.online (7), alibaba.oast.pro (2),
  oast.me, interact.sh, 169.254.169.254.nip.io, localhost (2), random `.tld`/`.com`/`.invalid` names. These are
  SSRF / host-header templates with hard-coded OAST hosts that `-ni` doesn't exclude (they don't use
  `{{interactsh-url}}`). Nuclei itself contacted only the target, but a vulnerable proxy on a real target could fetch
  those names. No `elsewhere.redwhale.test`. 747 requests got nginx's 400 (path traversal), logged as host `_`.
- Results of the measuring scan: php-detect (`8.3.12`), nginx-version (`nginx/1.30.6`), tech-detect (nginx, php),
  waf-detect (`nginxgeneric`, tags waf,tech), http-missing-security-headers (10 matchers).

## Next action

Wait for the user's answer on the time budget and the hard-coded OAST hosts, then step 2.
