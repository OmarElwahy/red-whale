# Tool group: vulnerability scanning (`vuln`)

Image `redwhale-tools/vuln:<hash>` (`pnpm tools:build vuln`). One tool, nuclei, **active**: the server asks for
`confirmActive`, passive-only must be off, and the target must be in scope.

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `nuclei` | v3.11.1 (2026-08-08), templates v10.5.1 (2026-10-23) | active | url | about 11,000 HTTP requests to the URL's host (≤ 5/s, up to 55 minutes); no intrusive, fuzzing or brute-force templates; no out-of-band callbacks; no redirects | none |

## Image

- nuclei is a checksummed release archive; the templates are GitHub's source archive of the `v10.5.1` tag, whose
  sha256 is the `nuclei-templates-10.5.1.tar.gz` line of the release's checksums.txt. `fetch_release.py --tree`
  extracts them to `/opt/nuclei-templates` (root-owned, read-only). The release is the newest one at least two weeks
  old when pinned. **nuclei never downloads or updates templates or itself**: `-duc` on every run, the templates
  folder given explicitly, `DISABLE_NUCLEI_TEMPLATES_*_DOWNLOAD=true` in the image, and nuclei never runs at build time.
- `/opt/nuclei-config` (`NUCLEI_CONFIG_DIR`) is made at build and read-only at run time: empty `config.yaml` and
  `reporting-config.yaml` (nuclei refuses to start on a read-only folder without them) and the templates'
  `.nuclei-ignore` (the default ignore list: tags dos, local, fuzz, bruteforce, txt-service and some templates with
  weak matchers; nuclei reads it only from the config folder).
- Updating the templates: pick a newer release (≥ 2 weeks old), take its tarball's sha256 from its checksums.txt,
  change both lines in the Dockerfile, rebuild, re-run the e2e (the template count and request count change).

## nuclei

Command (flags checked against `nuclei -h` of v3.11.1; probes in `docs/phase-6c6-progress.md`):

```
/usr/local/bin/nuclei -u <target without its trailing /> -t /opt/nuclei-templates/http/ -pt http -tags cve,misconfig,exposure,tech,takeover -etags intrusive,dos,fuzz,bruteforce,default-login,osint,ssrf,oast,proxy -eid <23 template IDs> -ni -dr -duc -rl 5 -c 5 -retries 1 -timeout 10 -mt 55m -jsonl -or -ot -nc -r /tmp/redwhale-nuclei-resolvers.txt
```

- **Templates:** HTTP only (TLS is testssl's, later; dns/network templates would reach outside the URL); about 6,500 load (6,495 listed by `-tl` after the exclusions).
  `ssrf`, `oast` and `proxy` are excluded because those templates make a vulnerable target fetch a hard-coded outside
  host (oast.pro, interact.sh, 169.254.169.254) that `-ni` doesn't exclude. Open-redirect checks that only put such
  a host in a parameter stay (with `-dr` nothing follows the redirect).
- **`-eid`: nuclei talks only to the URL.** 23 templates are excluded by ID (`run.py`):
  - `SIDE_PORT_IDS` (5): connect to a fixed **other port** of the host (`{{Hostname}}:<port>`: 4040, 6066, 43800,
    9780, 5814); ports are naabu's and nmap's.
  - `OUTSIDE_HOST_IDS` (18): connect to **another host** (`@Host:` in a raw request, or a literal URL in a path).
    15 check a token found on the target against its service's API (api.github.com, slack.com, api.stripe.com,
    api.telegram.org, ...): an outside contact that also uses a found credential. `azure-domain-tenant` asks
    login.microsoftonline.com about the domain (seen on a real target's first scan), `intercom-identity-
    misconfiguration` calls api-iam.intercom.io, `nginx-status-403-bypass` connects to localhost (the container).
  - `server/test/nuclei_template_set.py` (in the e2e) reads every loaded template and fails on any new side port or
    outside host, so a template update can't bring one in silently.
- **No outside contact:** `-ni` (no interactsh; templates that need it send nothing), `-dr` (never follow a redirect),
  `-duc`, no cloud upload (never `-pd`/`-dashboard`), DNS only through the container's resolver (`-r` takes only a
  file, so the script writes one; without a resolver nuclei is not run). A few templates send another name in the
  `Host` header (`localhost`, `interact.sh`, a random `.tld`): open-redirect and 403-bypass checks; the target only
  answers them.
- **Time:** `-mt 55m` inside the job's 3600 s. A scan stopped by `-mt`, or the target's own host:port skipped as
  unresponsive, makes the job `partial` (nuclei says so only on stderr, so the script runs without `-silent` and reads it).
- **Not handled here (later):** the `cve` set still holds state-changing checks not tagged `intrusive` (e.g.
  CVE-2022-1388's `POST /mgmt/tm/util/bash`; `rce`, `file-upload` tags): the intrusive-tools question.

Findings:

| Result | Finding |
|---|---|
| the URL a template matched at, if not the target | `url`, `has_url` from the target, `data.source: nuclei` |
| a `tech` template (not one with a CVE or the `waf` tag) | `technology` `uses_technology` from that URL: an extracted `name/version`, else the matcher name, else the template ID without `-detect`/`-version`; version only if it looks like one; spelled by `tech_value` (`nginx/1.30.6`, `php/8.3.12`, as httpx and nmap). A bare name is dropped when the same URL has it with a version |
| anything else | `vulnerability` `has_vulnerability` from that URL: the first CVE ID (uppercased; several → all in `data.cves`), else the template ID. Severity as nuclei says, `unknown` → `info` |

- One finding per value and URL: a template that matches with several matchers (http-missing-security-headers: one
  per header) is one finding, `data.matcher` a sorted list.
- `data`: `template`, `name`, `matched_at`, `matcher`, `extracted` (**masked**, e.g. `redw****cret`; ≤ 5), `cvss`
  (score), `references` (≤ 5), `tags`. Technologies keep their extracted values (versions). `raw.txt` keeps nuclei's
  own output, unmasked: the evidence, kept locally under `data/jobs/`.
- A match on another host is ignored. A match whose path has `.`/`..` segments (also `%2e`: path traversal) hangs
  off the target, `matched_at` as requested: the server resolves such segments, which would make a misleading node.
- Tests only: `run.py ... --template-ids a,b` adds `-id a,b`. nuclei ANDs it with the tag filters, so it only ever
  narrows the set; `tool.json` never passes it.

Fixture: a real capture against the lab (`fixtures/NOTE.md`). Lab: `/.git/config` and `/.env` with fake contents
(`lab/README.md`). e2e: `server/test/nuclei.e2e.test.ts` (fast: 4 templates; full: `REDWHALE_E2E_SLOW=1`).
