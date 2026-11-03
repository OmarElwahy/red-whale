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
| 2 | Lab image (`lab/`) + `pnpm lab:up/down/status` (server CLI through the runtime) + `lab/README.md` + `.test` wipe allowance | done |
| 3 | Server confirmation gate (428 `confirm-required`) + tests + `shared/` API schema | done |
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
- **Lab, as built (step 2):** nginx `1.30.6-alpine` pinned by index digest; openssl only in a throwaway `cert` stage
  (the base has no openssl CLI); `ENTRYPOINT nginx -g 'daemon off;'` (skips the image's entrypoint scripts). The
  container runs as nginx `101:101`, read-only root, cap-drop ALL, no-new-privileges, 128 MB, tmpfs `/tmp` +
  `/var/cache/nginx`; ports 80/443 via the namespaced sysctl `net.ipv4.ip_unprivileged_port_start=0` (no
  capability). Image `redwhale-lab:<12 hex of Dockerfile+index.html+nginx.conf>`; container `redwhale-lab`, labels
  `redwhale.lab=lab` + `redwhale.context=<hash>` (an older build is replaced by `lab:up`). `lab.ts` (pure spec +
  up/down/status over `ContainerRuntime`), `cli/lab.ts`. Runtime gained `createService(ServiceSpec)` (own strict body
  type; tool `ContainerCreateBody` unchanged) and `build()` (moved onto the interface; `BuildOptions` in runtime.ts).
- **Network IP range (added in step 2):** Docker gives dynamic addresses from the start of the pool, so a job could
  take the lab's .10. The network now has `IPRange` = the subnet's upper half (`172.29.250.128/25`); an existing
  network without it is refused with the `docker network rm` hint (the step-1 test had made one on this machine; removed).
- **Wipe guard:** new `isDisposableTarget` (`.example` or `.test`) for `foreignScans`; `isMockTarget` stays `.example`
  only, because it also validates `--domain`.
- **Confirmation:** `confirmActive?: boolean` on `POST /jobs` and `/jobs/group`; mode ≠ passive without it → 428
  `{ error, reason: "confirm-required" }`, checked in `orchestrator.enqueue*` before `authorize()` (no job row, no
  scope log). Order: 404 → 400 → 503 → 409 (preflight) → 428 → authorize. For a group, only the tools that accept the
  node's type count.
- **Gate, as built (step 3):** `EnqueueOptions { confirmActive? }` on `enqueue`/`enqueueGroup`; error code
  `confirm-required`, message `<tool> (<mode>) would contact <value> directly: confirm the active run first
  (confirmActive: true)`. shared: `confirmActive: z.boolean().optional()` on both create schemas,
  `CONFIRM_REQUIRED`, `jobConfirmRequiredResponseSchema` (strict `{ error, reason: 'confirm-required' }`),
  `JobCreateInput`/`GroupJobCreateInput`. A confirmed run still meets `authorize()` (passive-only on → 403 refused, logged).
  API tests use a temp copy of tools/ with findomain made active.
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

Step 4: `defs.ts` (`contacts`: required for active/intrusive, only `{target}`; `{targetType}` argv placeholder,
optional, at most once, whole item), `spec.ts` fills `{targetType}` (checked against NODE_TYPES), `toolDto` returns
`contacts` (+ shared `toolInfoSchema`); `redwhale_tool.py` `--target-type` + `tech_value` (+ unit tests);
`check.py` reads `target_type`; `tools/http/` group (Dockerfile with httpx v1.12.0 + checksum, group.json, README),
`tools/http/httpx/` (tool.json, run.py), verify flags with `httpx -h` in the built image, capture fixture from the
lab (`pnpm lab:up` is already built on this machine), anonymize, `pnpm tools:check httpx --update`.
