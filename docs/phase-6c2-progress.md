# Phase 6C-2 — First active tool (tools network, lab, active-run confirmation, httpx): progress

Branch `phase-6c2`, cut from `graph-editing` (14b2315 "docs: handoff"; nothing is merged into main yet, keep the
stack). **Don't merge into main**: the user merges after their manual check. After each step: `pnpm typecheck` +
`pnpm test` green → update this file → commit "6C-2 step N: <what>" → `git push` (first time
`git push -u origin phase-6c2`). If a session is cut off: read this file, check `git log`, continue at "Next action".

Spec: the user's 6C-2 request (network, lab, confirmation, `http` group with httpx; not dnsx/naabu, redirect
following, presets, intrusive tools). The user's machine: Windows + PowerShell + Docker Desktop (WSL2): every command
in docs must work in PowerShell (no `&&`). No DB schema change expected; ask first if one is needed.

## Steps

| # | Step | Status |
|---|---|---|
| 1 | Tools network `redwhale-tools` in the runner (`network.ts`, `ensureNetwork` in runtime/docker/fake, spec uses it) + tests; real-Docker subdomain suite re-run | done |
| 2 | Lab image (`lab/`) + `pnpm lab:up/down/status` (server CLI through the runtime) + `lab/README.md` + `.test` wipe allowance | |
| 3 | Server confirmation gate (428 `confirm-required`) + tests + `shared/` API schema | |
| 4 | `http` group + httpx (Dockerfile, tool.json with `contacts`, run.py, `tech_value`, `{targetType}`, lab fixture, `tools:check`) | |
| 5 | UI: active-run confirmation dialog, Run tool menu wiring, Jobs tab check | |
| 6 | Real-Docker end-to-end test; docs (architecture §2/§6/§11/§13, team-guide, handoff); manual checklist below | |

## Decisions (approved plan + user's answers)

- **Network:** one user-defined bridge network `redwhale-tools`, label `redwhale.network=tools`, NOT internal (tools
  need the internet). Subnet `172.29.250.0/24`, override `REDWHALE_NET_SUBNET` (IPv4, /16 to /28, host bits zero;
  a bad value turns the runner off at server start with the reason). `server/src/runner/network.ts` is pure (spec,
  subnet rules, error texts); `docker.ts` (still the only dockerode importer) applies it in `ensureNetwork`:
  inspect → create if missing; an existing one must be ours, bridge, not internal and on the same subnet, else a clear
  error with `docker network rm redwhale-tools`; Docker's "Pool overlaps" → "set REDWHALE_NET_SUBNET to a free range".
  A create race (409) re-inspects. The orchestrator calls `ensureNetwork` right before each container create; a
  failure fails the job with that message, no container. `recover()` never removes the network (shared by all
  workspaces and the lab). `spec.ts`: `NetworkMode: 'redwhale-tools'`; everything else unchanged.
- **Lab:** nginx alpine pinned by digest; HTTP 80 `/` → 301 `https://elsewhere.redwhale.test/`; HTTPS 443 serves the
  page (title); both send `Server` + `X-Powered-By`; self-signed cert made at build; access log records `$host`.
  Container label `redwhale.lab`, aliases `lab.redwhale.test` + `elsewhere.redwhale.test`, IP = subnet host .10
  (`172.29.250.10`), no host ports. `lab:up` never adds scope rules, it prints them. Mock wipe accepts `.test` too.
- **Confirmation:** `confirmActive?: boolean` on `POST /jobs` and `/jobs/group`; mode ≠ passive without it → 428
  `{ error, reason: "confirm-required" }`, checked in `orchestrator.enqueue*` before `authorize()` (no job row, no
  scope log). Order: 404 → 400 → 503 → 409 (preflight) → 428 → authorize. For a group, only the tools that accept the
  node's type count.
- **`{targetType}`** (user's answer 1): optional argv placeholder, at most once, whole item; `spec.ts` fills it from the
  ScopedTarget's type (checked against the node-type enum); `main()` takes optional `--target-type`, a tool that needs it
  and doesn't get it fails clearly, never guesses; `check.py` reads `target_type` from expected.json; subdomain tools
  unchanged. Document in team-guide + architecture §11, log in §13.
- **`contacts`** (answer 2): tool.json field, required for active/intrusive, optional for passive; only placeholder
  `{target}` (catalog rejects others); returned by GET /tools; display text only.
- **Redirect proof** (answer 3): e2e asserts no request reached Host `elsewhere.redwhale.test` (lab access log) and
  the `http://` finding has status 301 with the Location in data.
- **httpx:** v1.12.0 (2026-09-08), linux_amd64, sha256 from its checksums.txt; `/usr/local/bin/httpx`. Chain
  target → resolves_to ip → has_port port → serves url → uses_technology technology. `tech_value(name, version)`:
  lowercase, whitespace runs → `-`, `/` in the name → `-`, version whitespace removed, empty version → name only.
  Fixture host `lab.redwhale.test` → `lab.northwind.example`, `172.29.250.10` → `198.18.0.10`.

## Next action

Step 2: `lab/` (Dockerfile pinned nginx alpine digest, nginx.conf, cert at build), `server/src/runner/lab.ts` (pure
spec, `createService` in runtime), `server/src/cli/lab.ts` + `lab:up/down/status` scripts, `isMockTarget` `.test`,
`lab/README.md`.
