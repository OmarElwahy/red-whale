# nuclei fixture

`raw.jsonl` lines 1–18 are real nuclei v3.11.1 output (templates v10.5.1), captured on 2026-11-24 against the RED
WHALE local lab (`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/vuln` image on the `redwhale-tools`
network, as user 10001 with a read-only root filesystem, by
`run.py --target https://lab.redwhale.test/ --template-ids git-config,laravel-env,generic-env,nginx-version,php-detect,tech-detect,waf-detect,http-missing-security-headers`.
The exact command `build_command` ran:

```
/usr/local/bin/nuclei -u https://lab.redwhale.test -t /opt/nuclei-templates/http/ -pt http -tags cve,misconfig,exposure,tech,takeover -etags intrusive,dos,fuzz,bruteforce,default-login,osint,ssrf,oast,proxy -ni -dr -duc -rl 5 -c 5 -retries 1 -timeout 10 -mt 55m -jsonl -or -ot -nc -r /tmp/redwhale-nuclei-resolvers.txt -id git-config,laravel-env,generic-env,nginx-version,php-detect,tech-detect,waf-detect,http-missing-security-headers
```

(`-r` names a file with the container's own resolver, `127.0.0.11:53`. `-id` narrows the full template set to the 8
templates that fire on the lab, so the capture took 11 s instead of ~37 min; nuclei ANDs `-id` with the tag filters.)
nuclei's stderr: "Templates loaded for current scan: 8", "Scan completed in 8.8s. 18 matches found."
The capture had 18 lines; all are kept, in nuclei's order (it varies between runs).

- Line 1: `waf-detect`, tagged `waf,tech`: a vulnerability (info), not a technology.
- Line 2: `git-config` at `/.git/config`, `extracted-results` `["redwhale-lab:fake-not-a-secret"]` (the lab's fake
  remote URL credentials): masked in the finding (`redw****cret`).
- Lines 3, 5: `laravel-env` and `generic-env` at `/.env` (the lab's fake `.env`).
- Lines 4, 6: `php-detect` (`8.3.12`) and `nginx-version` (`nginx/1.30.6`): technologies `php/8.3.12`, `nginx/1.30.6`,
  spelled as httpx and nmap spell them.
- Lines 7–16: `http-missing-security-headers`, one line per matcher: one finding, `data.matcher` a sorted list of 10.
- Lines 17–18: `tech-detect` `nginx` and `php`: dropped, the same URL has both with a version.

The lab's access log for the run had 49 requests, all `host=lab.redwhale.test` (the 22 `.env` paths of laravel-env
and generic-env, `/.git/config`, `/` and one `POST /` from waf-detect).

**Anonymized:** `lab.redwhale.test` → `lab.northwind.example`. Nothing else was changed (same fields, order and
spacing; timestamps, the lab's IP and curl commands as captured).

**Edited lines** (the lab has nothing a CVE template fires on, and nuclei never reports another host with `-dr`):

- Line 19: a copy of line 2 as `CVE-2021-41773` (critical, `cve-id` `["cve-2021-41773","CVE-2021-42013"]`, cvss
  9.8, one reference) matched at `/cgi-bin/.%2e/.%2e/etc/passwd`: value `CVE-2021-41773` (uppercased), `data.cves`
  both IDs; the path has dot segments, so it hangs off the target, with `matched_at` as requested.
- Line 20: a copy of line 2 matched at `https://elsewhere.northwind.example/.git/config`: ignored.

`expected.json` is what `run.py --target https://lab.northwind.example/ --replay fixtures/raw.jsonl` must produce.
