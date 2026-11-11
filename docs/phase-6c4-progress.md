# Phase 6C-4 — nmap (active service/version detection): progress

Branch `phase-6c4`, cut from `main` (31be938; everything through 6C-3 is merged). **Don't merge into main**: the user
merges after a manual check. After every step: `pnpm typecheck` + `pnpm test` green → update this file → commit
"6C-4 step N: <what>" (with this file) → `git push` (first time `git push -u origin phase-6c4`).
If a session is cut off: read this file, check `git log`, continue at "Next action". Don't ask the user.

Spec: the user's 6C-4 request. Goal: the lab answers on TCP 22 with a fake SSH banner, nmap in the existing `ports`
group, a real-Docker e2e test and docs. **Not in scope:** NSE scripts (`-sC`/`--script`), UDP, OS detection, other
tools, presets/auto-chaining, schema changes. Commands in docs must work in PowerShell (no `&&`).

## Steps

1. ✅ Lab banner on TCP 22 + README/status.
2. ⬜ nmap in the `ports` group (Dockerfile, tool.json with `contacts`, run.py, the library's type-aware command
   builder, fixtures for ip and port mode, unit tests, `tools:check`).
3. ⬜ Real-Docker e2e test; docs: architecture §11/§13, team-guide (nmap as the XML example, the apt-pin exception,
   the new builder signature), handoff status; manual check list in this file.

## Decisions (from the user, 2026-11-11)

- **Lab:** nginx `stream` server on 22 returns `SSH-2.0-OpenSSH_9.6p1\r\n` and closes. No real SSH (comment +
  README). Still no host ports. `LAB_PORTS` = 22, 80, 443, 8080 (`lab:status` lists them).
- **Type-aware command builder (library):** when `main(..., needs_target_type=True)`, `main()` calls
  `command(target, target_type)`; otherwise `command(target)` exactly as before (the subdomain tools' builders don't
  change). Unit-test both paths in `tools/lib`. Document the signature in team-guide.md. nmap picks ip or port mode
  from the **type** and refuses a value whose shape doesn't match it (clear error, nmap never runs). Reason: the
  server already decided the type; guessing it from the value's shape is the mistake avoided for httpx's parent.
- **`-sV` runs nmap's "version" category scripts automatically.** Accepted (option a). `contacts` says so:
  "…sends service-detection probes, including nmap's built-in version-detection scripts (no other scripts)".
  Confirm the scripts with `-d`; record count and names in §13. The forbidden-flags test stays
  (`-sC`, `--script`, `-O`, `-A`, `-sU`).
- **Install:** nmap (and nmap-common) from the digest-pinned base image's Debian repository, exact version pinned
  (`NMAP_VERSION` in `tools/ports/Dockerfile`); exception to "sha256-checked release" (apt packages are signed; nmap
  ships no checksummed Linux binary). Plain pin, no snapshot.debian.org. A failed `pnpm tools:build ports` must say:
  "the pinned nmap version may have left Debian's repository; bump NMAP_VERSION in tools/ports/Dockerfile". Bump rule
  in §13.
- **Timing:** `timeoutSec` 600, `--host-timeout 480s`, `--max-rate 50`, `--max-retries 1`. Record in §13.
- **Closed/filtered port target:** not an error. Success, no findings; the state stays in the raw output. Only real
  problems (bad XML, a crash, a timeout) use `run.error()`.
- **Findings:** every open port → `port` (`port_value()`), `has_port` from the IP, data `service`, `product`,
  `version`, `extrainfo`, `tunnel` when present; product known → `technology` (`tech_value(product, version)`) with
  `uses_technology` from the port (the contract has `port → technology`). Closed/filtered ports are not findings.
- **Fixtures:** `tools:check` takes exactly one `raw.*`: ip mode is `fixtures/raw.xml` + `expected.json` (checked by
  `tools:check`); port mode is `fixtures/port/raw.xml` + `fixtures/port/expected.json`, replayed by a unit test in
  `test_nmap.py` (which `tools:check` and `pnpm test` run).

## Done

- **Step 1.** `lab/nginx.conf`: a `stream` block (before `http`, so the `listen` order is 22, 80, 443, 8080) with
  `return "SSH-2.0-OpenSSH_9.6p1\r\n";` and a stream access log (`ssh <addr> <status> <bytes>`). The pinned
  `nginx:1.30.6-alpine` is built `--with-stream` (static; checked with `nginx -V`). `lab.ts`: `LAB_PORTS`
  `[22, 80, 443, 8080]`, `lab:up` prints the banner line. `lab/README.md`: the port, "not a real SSH server".
  Checked by hand: from a container on `redwhale-tools`, a connect to `172.29.250.10:22` reads exactly
  `SSH-2.0-OpenSSH_9.6p1\r\n`, then EOF. `portscan.e2e.test.ts` (naabu) still passes: it loops over `LAB_PORTS` and
  naabu's top 100 include 22.

## Next action

Step 2: find the trixie nmap version in the pinned base image (`apt-cache policy nmap`), add it to
`tools/ports/Dockerfile`, then the library change, run.py, tool.json, fixtures, tests.
