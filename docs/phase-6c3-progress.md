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
2. ⬜ `dns` group + dnsx (Dockerfile, tool.json, run.py, the shared resolver helper, fixture, `tools:check`).
3. ⬜ `ports` group + naabu (Dockerfile, tool.json with `contacts`, run.py, fixture, `tools:check`).
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

## Done

- **Step 1:** `lab/nginx.conf` third server on 8080 (`default_type text/plain`, `200 "redwhale lab 8080\n"`; same
  `Server`/`X-Powered-By` since they're http-level). `lab.ts`: `LAB_PORTS = [80, 443, 8080]`, `lab:up` prints the 8080
  line, `lab:status` prints `ports      80/tcp, 443/tcp, 8080/tcp  (tools network only)`. `lab.test.ts`: the status
  line, and nginx.conf's `listen`s equal `LAB_PORTS`. `lab/README.md` table + ports sentence. Checked for real: lab
  rebuilt (`redwhale-lab:9ee3350a0b4a`), `http://lab.redwhale.test:8080/` from a tools-network container → 200,
  `nginx/1.30.6`, `PHP/8.3.12`; `docker port redwhale-lab` empty. Architecture §11 lab paragraph is updated in step 4.

## Next action

Step 2: `dns` group + dnsx. Download dnsx v1.3.1 linux_amd64 + checksums, verify flags with `dnsx -h` inside the
built image, move `resolvers()` + the refusal into the helper (`main(..., needs_resolvers=True)`; skipped on
`--replay`), unit tests in `tools/lib/test_redwhale_tool.py`, httpx uses it, capture the fixture against the lab,
anonymize (`lab.northwind.example`, `198.18.0.10`), add edited AAAA/CNAME lines (marked in NOTE.md).
