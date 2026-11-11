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
4. ✅ Real-Docker e2e test (`server/test/portscan.e2e.test.ts`); docs: architecture §9 (later improvements), §11, §13,
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

- **Step 4:** `server/test/portscan.e2e.test.ts` (skipped unless Docker + images `dns`, `http`, `ports` and the lab
  image): seed → dnsx (passive, no confirmation; `resolves_to` discovered, 1 source; the seeded subdomain gains no
  dnsx finding) → httpx confirmed → naabu unconfirmed = `confirm-required`, then confirmed → ports 80/443/8080 exist;
  `has_port` 80/443 corroborated (2 sources), 8080 discovered (naabu only); `resolves_to` corroborated; the ip seen by
  dnsx + httpx; no containers/volumes left. Green against the real lab. Docs: architecture §9 (dangling CNAME later
  improvement), §11 (lab 8080, `ValueError` refusal, `resolver_args`/`needs_resolvers`, groups `dns`/`ports`), §13
  (5 rows); team-guide (dnsx/naabu in the "copy" table, resolver + refusal sections, helper row, lab ports and IP
  targets for fixtures); handoff (main = through 6C-2, 6C-3 row, decisions, open items); `tools/http/README.md`
  (the refusal). CLAUDE.md: no command changed.

## Next action

All four steps are done and pushed. Waiting for the user's manual check (below); the user merges. Nothing else to do
on this branch unless the check finds something.

## Manual check (PowerShell, from the repo root)

**Setup** (proves the new images build from the pinned, checksum-verified releases and the lab has its new port):

1. `git switch phase-6c3`, then `pnpm install`.
2. `pnpm tools:build`: builds `dns` and `ports` (new) and rebuilds `http` (the helper changed).
3. `pnpm lab:up`: rebuilds the lab (nginx.conf changed). Its output now lists `http://lab.redwhale.test:8080/`.
4. `pnpm lab:status`: shows `ports      80/tcp, 443/tcp, 8080/tcp  (tools network only)`.
   `docker port redwhale-lab` prints nothing (still no host ports).
5. `pnpm tools:check --all`: `✓ all 7 passed` (dnsx and naabu replay their fixtures; no Docker or network needed).
6. `pnpm dev`, open http://127.0.0.1:5173.

**dnsx, passive** (proves: no dialog for a passive tool, `ip` + `resolves_to`, the target not reported):

7. Scope panel: add `include domain lab.redwhale.test` and `include ip 172.29.250.10`. Leave passive-only **on**.
8. Canvas right-click ▸ Add node… ▸ subdomain `lab.redwhale.test`. Right-click it ▸ Run tool ▸: **dnsx** is enabled
   (passive), httpx is disabled (passive-only). naabu isn't listed (it takes IPs only).
9. Click **dnsx**: no dialog, "queued 1 job"; the Jobs tab shows it succeed. The graph: `lab.redwhale.test` →
   `172.29.250.10`. Select the edge: 1 source (dnsx), discovered. Select `lab.redwhale.test`: its provenance has no
   dnsx entry as a finding (only as the parent of the ip).

**naabu, active** (proves: confirmation for an IP target, connect scan finds 8080, no extra capabilities):

10. Right-click `172.29.250.10` ▸ Run tool ▸ **naabu**: disabled, "Passive-only mode is on". Turn passive-only
    **off**. Click naabu: the dialog shows ACTIVE, target `ip 172.29.250.10`, "Contacts the target: connects to TCP
    ports of 172.29.250.10 (top 100 ports, at most 50 connections per second; connect scan, no raw packets)",
    "External services: none", **In scope** with `include ip 172.29.250.10 #N`.
11. **Cancel**: no job. Again ▸ **Run active scan**: the job succeeds in a few seconds. The graph: `172.29.250.10` →
    `:80/tcp`, `:443/tcp`, `:8080/tcp`; each port's data has `protocol tcp`.
12. While it runs (or from the job's argv in the Jobs tab): the container has no added capability. Optional:
    `docker inspect` on a running naabu job container shows `CapDrop [ALL]` and no `CapAdd`.

**Corroboration** (proves: two tools on one edge = corroborated, one = discovered):

13. Run **httpx** on `lab.redwhale.test` (confirm). Then select the `172.29.250.10 → :80/tcp` edge: corroborated,
    2 sources (httpx, naabu); same for `:443/tcp`; `:8080/tcp` stays discovered (naabu). The
    `lab.redwhale.test → 172.29.250.10` edge is now corroborated (dnsx, httpx).

**Refusals** (proves: scope still decides; IP rules only):

14. Scope panel: remove `include ip 172.29.250.10`. Run tool ▸ naabu on the ip: disabled (out of scope; a domain in
    scope never puts its IPs in scope). Add it back.
15. Server gate (PowerShell 5.1 shows the 428 as an error, which is the point). Copy the ip node's ID from its side
    panel, then:
    `Invoke-WebRequest -Method Post -Uri http://127.0.0.1:4100/api/jobs -ContentType application/json -Body '{"tool":"naabu","nodeId":"<id>"}'`
    fails with `(428)`; no job, no scope log entry.

**Resolver refusal** (proves: no silent public resolvers; replays still work without one). On Windows there is no
`/etc/resolv.conf`:

16. `py -3 tools/dns/dnsx/run.py --target lab.redwhale.test --target-type subdomain --out $env:TEMP\rw-dnsx`
    exits without running dnsx; `Get-Content $env:TEMP\rw-dnsx\result.json` shows `"status": "failed"` and
    `"no system resolver found; refusing to use public ones"`, `"command": ""`.
17. The same with `--replay tools/dns/dnsx/fixtures/raw.jsonl` added (and `--target lab.northwind.example`):
    `"status": "success"`, 2 findings.

**Nothing broken:**

18. `pnpm lab:down`, then `pnpm lab:status`: container none, image still built.
19. `pnpm mock` still runs without `--force` after the lab scans (`.test` is disposable).
