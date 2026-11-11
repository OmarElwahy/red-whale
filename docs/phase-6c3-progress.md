# Phase 6C-3 — dnsx (passive DNS) and naabu (active port scan): progress

Branch `phase-6c3`, cut from `main` (3dd6d57; everything through 6C-2 is merged). **Don't merge into main**: the user
merges after a manual check. After every step: `pnpm typecheck` + `pnpm test` green → update this file → commit
"6C-3 step N: <what>" (with this file) → `git push` (first time `git push -u origin phase-6c3`).
If a session is cut off: read this file, check `git log`, continue at "Next action". Don't ask the user.

Spec: the user's 6C-3 request. Goal: lab on TCP 8080, a `dns` group with dnsx, a `ports` group with naabu, a
real-Docker e2e test and docs. **Not in scope:** nmap, other tools, DNS brute-forcing, presets/auto-chaining, redirect
following, schema changes. Commands in docs must work in PowerShell (no `&&`).

## Steps

1. ✅ Lab port 8080 + README/status.
2. ✅ `dns` group + dnsx (Dockerfile, tool.json, run.py, the shared resolver helper, fixture, `tools:check`).
3. ✅ `ports` group + naabu (Dockerfile, tool.json with `contacts`, run.py, fixture, `tools:check`).
4. ⬜ Real-Docker e2e test (`server/test/portscan.e2e.test.ts`); docs: architecture §9 (later improvements), §11, §13,
   team-guide (dnsx and naabu as examples, the resolver helper), handoff status; manual check list in this file.

## Decisions (from the user, 2026-11-11)

- **Pins:** dnsx **v1.3.1** (2026-08-31), naabu **v2.7.0** (2026-10-28, exactly 14 days old on 2026-11-11), latest
  stable ≥ 2 weeks old, linux/amd64, sha256 from the release checksums file, called by absolute path. naabu: the
  glibc zip (not `_musl`) on the Debian base; install libpcap only if the binary needs it even for a connect scan.
- **dnsx input:** v1.3.1's `-l` takes "file or comma separated or stdin", so `-l <target>` works and the helper needs
  **no input change**. Because `-l` reads a file if one exists by that name, dnsx's run.py refuses a target that
  contains `,` or exists as a path (cwd is the empty `/tmp`; hostnames contain neither).
- **Resolvers (shared helper):** `resolvers()` moves from httpx's run.py into `tools/lib/redwhale_tool.py`. With **no
  nameserver in /etc/resolv.conf**, the tool **refuses**: status `failed`, error exactly
  `no system resolver found; refusing to use public ones`, the tool never runs. **Both dnsx and httpx** (httpx used to
  run without `-r` = public resolvers, an undeclared contact). `--replay` skips the check entirely (teammates replay
  fixtures on Windows; `tools:check` stays green there). Log in §13.
- **dnsx never reports its target as a finding.** Findings: `ip` with `resolves_to` from `({targetType}, target)`
  for A/AAAA answers; the CNAME goes in **each ip finding's data** (`cname: "<name>"`). A CNAME with no A/AAAA answer
  (dangling) produces no finding in 6C-3: mention it in the run's raw output only (stderr log), and add "dangling
  CNAME detection (subdomain takeover)" to architecture §9 "Later improvements" (needs its own node/relation design).
  Reason: corroboration = two tools independently discovered something; resolving the name you were given isn't
  discovery (httpx doesn't report its target either). Log in §13.
- **naabu:** `mode: active`, `accepts: ["ip"]`, `external: []`, connect scan, `-Pn`, top 100, 50/s, conservative
  concurrency/timeout/retries, JSON, silent, no color, no update check; container hardening unchanged (no capability).
  Top-100 in v2.7.0 (`pkg/runner/ports.go` NmapTop100) includes 80, 443, 8080. Findings: `port` via `port_value()`,
  `has_port` from the IP, `data.protocol`. Final argv goes in §13.
- `tools:check` doesn't compare `command`, so a replayed command without `-r` (no resolv.conf) doesn't matter.
- **Mine (small, inside the spec):** `data.cname` is a string for one CNAME, the chain as a list (dnsx's order) for
  several. A command builder may raise `ValueError` to refuse a target (helper: error recorded, nothing runs,
  status `failed`); dnsx uses it for the comma/path guard. dnsx `timeoutSec` 120.
- **dnsx final argv** (v1.3.1, every flag in its `-h`; for §13):
  `/usr/local/bin/dnsx -l <target> -a -aaaa -cname -j -silent -nc -duc -rl 10 -t 5 -retry 2 -r <resolv.conf servers>`.
  `-hf` (hosts file) is off by default and not passed.
- **naabu final argv** (v2.7.0, every flag in its `-h`; for §13):
  `/usr/local/bin/naabu -host <ip> -s c -Pn -tp 100 -rate 50 -c 10 -timeout 2s -retries 1 -j -silent -nc -duc -no-stdin`.
  **No libpcap**: `ldd` shows only libc/libdl/libpthread, and the connect scan runs as 10001 with `--cap-drop ALL`
  ("Running CONNECT scan with non root privileges"). No outside calls: with `--network none` against 127.0.0.1 it
  finishes in 3 s with no network errors (the only warning: "UI Dashboard is disabled"). `run.py` refuses any
  target that isn't exactly one IP (`ValueError` → `failed`, naabu not run). `contacts` unchanged from the spec.
  `timeoutSec` 300.

## Done

- **Step 1:** `lab/nginx.conf` third server on 8080 (`default_type text/plain`, `200 "redwhale lab 8080\n"`; same
  `Server`/`X-Powered-By` since they're http-level). `lab.ts`: `LAB_PORTS = [80, 443, 8080]`, `lab:up` prints the 8080
  line, `lab:status` prints `ports      80/tcp, 443/tcp, 8080/tcp  (tools network only)`. `lab.test.ts`: the status
  line, and nginx.conf's `listen`s equal `LAB_PORTS`. `lab/README.md` table + ports sentence. Checked for real: lab
  rebuilt (`redwhale-lab:9ee3350a0b4a`), `http://lab.redwhale.test:8080/` from a tools-network container → 200,
  `nginx/1.30.6`, `PHP/8.3.12`; `docker port redwhale-lab` empty. Architecture §11 lab paragraph is updated in step 4.

- **Step 2:** helper (`tools/lib/redwhale_tool.py`): `RESOLV_CONF`, `NO_RESOLVER`, `resolvers(path=None)` (moved
  from httpx), `resolver_args(flag="-r")`, `main(..., needs_resolvers=False)` (real run with no resolver → error, tool
  not run, `failed`; `--replay` skips it), `command()` may raise `ValueError` → refused. httpx: `*resolver_args()` +
  `needs_resolvers=True` (same argv as before when a resolver exists). `ResolverTest` (7 tests) in
  `test_redwhale_tool.py`. New `tools/dns/{group.json, Dockerfile, README.md}`, `tools/dns/dnsx/{tool.json, run.py,
  test_dnsx.py, fixtures/{raw.jsonl, NOTE.md, expected.json}}` (2 ips, both with `cname`; dangling line → nothing).
  Server tests updated for the new group (`runner-docker`, `api/jobs`, `tools-fixtures`: 6 tools). Images:
  `redwhale-tools/dns:a20f13d7faec`, `redwhale-tools/http:8e766cfbbf2b` (rebuilt: helper changed); the httpx e2e ran
  green on it. Real capture: 1 line (A only; Docker DNS has no AAAA/CNAME).
- **Flake seen once:** in one full `pnpm test` run, `tools-fixtures.test.ts › every tool in the repo passes` failed
  (output not captured); it passed alone and in the next 3 full runs. If it comes back, capture `r.out`.

- **Step 3:** `tools/ports/{group.json ("port scanning"), Dockerfile (no libpcap), README.md}`,
  `tools/ports/naabu/{tool.json, run.py, test_naabu.py, fixtures/{raw.jsonl, NOTE.md, expected.json}}` (3 real lines
  80/443/8080 anonymized to `198.18.0.10`, + a duplicate and a blank line). Image `redwhale-tools/ports:989aa81a243f`.
  Server tests: group/tool lists (`runner-docker`, `api/jobs`, `tools-fixtures`: 7 tools); `api/jobs` used `ports` as
  "an unknown group": now `no-such-group` → 404, and `ports` on a domain → 400 "naabu can't be run against a domain".

## Next action

Step 4: `server/test/portscan.e2e.test.ts` (copy the shape of `httpx.e2e.test.ts`; ready = Docker + images `dns`,
`http`, `ports` + lab image): seed subdomain `lab.redwhale.test`, the two scope rules, passive-only off; dnsx with no
confirmation → ip + `resolves_to`; httpx confirmed; naabu on the ip node without `confirmActive` →
`confirm-required`, then confirmed; assert ports 80/443/8080, `has_port` 80/443 `corroborated`, 8080 `discovered`,
`resolves_to` `corroborated` (edge confidence: check how edges expose it, `edge_observations` / `GET /edges/:id`).
Then docs: architecture §9 later improvements (dangling CNAME detection), §11 (lab 8080, groups `dns`/`ports`,
`needs_resolvers`, command may refuse with ValueError), §13 rows (pins + final argvs, resolver refusal, dnsx never
reports its target / cname in ip data), team-guide (dnsx + naabu examples, `resolver_args`/`needs_resolvers`),
handoff status (and its stale "main has only 6A"), CLAUDE.md if commands changed (they didn't), manual check list here.
