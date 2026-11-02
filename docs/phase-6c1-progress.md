# Phase 6C-1 — Orchestrator core + subdomain enumeration group: progress

Branch `phase-6c1`, cut from `phase-6b` (3ec8c82; main doesn't have 5D/6B yet). **Don't merge into main**: the user
merges after their manual check. After each step: `pnpm typecheck` + `pnpm test` green → commit
"6C-1 step N: <what>" (with this file) → `git push` (first time `git push -u origin phase-6c1`).
If a session is cut off: read this file, check `git log`, continue at "Next action". Don't ask the user.

Spec: the user's 6C-1 request (runner, tools, template for teammates, jobs, API, UI, checkpoints, tests). The
approved plan is summarized under "Decisions".

## Steps

| # | Step | Status |
|---|---|---|
| 1 | runner interface (`runtime.ts`) + fake (`server/test/fakeRuntime.ts`) + hardening (`spec.ts`) + argv/injection tests; tool-def schema (`defs.ts`) | done |
| 2 | `0004_jobs` migration (jobs, runner_state) + orchestrator queue + concurrency + scope-change cancel + restart/orphan handling (fake runtime) | next |
| 3 | `docker.ts` (dockerode) + tool.json/group.json loader + Dockerfile + `.dockerignore` + Python helper (+ unittest) + `pnpm tools:build`. Needs Docker Desktop | |
| 4 | subfinder script + anonymized real fixture + expected.json | |
| 5 | assetfinder (same) | |
| 6 | findomain (same) | |
| 7 | crt.sh (same; retries unit-tested in Python) | |
| 8 | `pnpm tools:check <tool\|--all>` (tools/check.py + TS wrapper), Vitest runs it for every tool | |
| 9 | job execution → ingest → raw output storage + real-Docker integration test (skipped without Docker/image) | |
| 10 | API + WS (`job.updated`, `runner.status`), group jobs | |
| 11 | UI: Run tool submenu, Jobs tab, header runner status (may split 11a/11b) | |
| 12 | Docs: architecture.md (new §12 Orchestrator, §4, §6, §9, decisions log), team-guide.md rewrite, group README, handoff.md | |

## Decisions (approved plan + user's answers)

- **Fixture capture (steps 4–7):** run the four tools myself, in Docker (the built image), against the domain the
  user names. **The user's message said `<DOMAIN>` literally (placeholder not filled in); asked for the real one.**
  Don't guess a domain. The repo is public: **never commit real hostnames**. After capturing, keep each file's
  exact format but rewrite every hostname consistently to a fake one under `northwind.example`
  (`dev.<real>` → `dev.northwind.example`); keep lines covering wildcards, uppercase, trailing dots, duplicates;
  add a short `NOTE.md` in each `fixtures/` saying the data was anonymized. Keep raw captures out of the repo
  (scratchpad only).
- **`/out` = a per-job named Docker volume** `redwhale-job-<id>` (tmpfs is gone once a container exits, so
  getArchive after exit can't read it). Labeled `redwhale.job=<id>` (+ `redwhale.workspace`, `redwhale.tool`).
  Order after exit: fetch → remove container → **remove volume right away**. Startup orphan cleanup removes
  this workspace's labeled containers **and volumes**. Not a bind mount. `/tmp` stays tmpfs; rootfs read-only.
- **Size caps enforced while fetching** (tar headers give real sizes): raw.txt/stdout/stderr 5 MB each (truncated
  with a note), result.json up to 50 MB (over → job fails, never truncated), total archive read capped; files we
  don't keep are reported with sizes in the job's error/notes, so a runaway tool is noticed. Docker's json-file
  log is capped at 10 MB too.
- **One folder per tool:** `tools/<group>/<tool>/{tool.json, run.py, fixtures/raw.*, fixtures/expected.json,
  fixtures/NOTE.md}`; `tools/<group>/{group.json, Dockerfile, README.md}`; shared helper `tools/lib/redwhale_tool.py`.
  A **`.dockerignore`** keeps `fixtures/` and tests (`test_*.py`) out of the image. Build context = `tools/`.
- **"Jump to the resulting scan"** = "Show results": select the job's target node (open its path), highlight that
  scan's rows in its provenance table. **Job rows also show "+N new, M updated"** nodes from the scan → store
  `nodes_created` / `nodes_updated` on the job (from the ingest result: created.nodes, touched − created).
- The old unmerged `team-tool-template` branch (tools/redwhale.py, TEMPLATE_runner.py) is superseded; its good
  parts (relation inference, clean_value, mask_secret, replay) go into `tools/lib/redwhale_tool.py`.
- Tool modes `passive | active | intrusive` (`shared/src/tools.ts`); scope checks `passive` as passive, the
  others as active (`scopeModeFor`).
- Container spec is plain Engine API JSON built by `spec.ts` (pure, tested); `docker.ts` passes it straight to
  dockerode. Labels `redwhale.job`, `redwhale.workspace` (a uuid in `runner_state`, so a scratch server's cleanup
  never kills the dev server's containers), `redwhale.tool`. User 10001:10001, cap-drop ALL, no-new-privileges,
  1 GB (no swap), 1 CPU, pids 256, tmpfs /tmp noexec, bridge network (tools need the internet), Init, no Binds.
- Entrypoint = argv[0], Cmd = the rest (the image's entrypoint never wraps it). Env: `HOME=/tmp` (subfinder writes
  its config there), `PYTHONDONTWRITEBYTECODE=1`, `REDWHALE_TOOL_TIMEOUT` = def timeout − 30 s (script writes a
  partial result before the hard kill).
- Argument injection: `{target}` must be one whole argv item exactly once (schema + buildArgv); `safeArgValue`
  refuses a leading `-`, whitespace, control chars. Found: authorize() already refuses `-x.example.com`
  ("can't check an invalid subdomain value"), so the runner check is a second layer; tested both.
- Jobs: `queued_scope_log_id` (decision at queueing) **and** `scope_log_id` (decision right before start).
  A job refused at queueing or at start → status `refused` with the reason. Scope changes re-check queued jobs
  without logging and cancel the out-of-scope ones. Queued jobs survive a restart (re-authorized at start);
  running → failed "server restarted".
- `POST /jobs`: 403 refused (stored as `refused`), 409 image not built, 503 Docker unreachable (409/503: no row, no
  scope decision logged). Group: one authorize() per tool. result.json's `tool` must equal the def name, else the
  job fails. Valid results are always ingested (a failed scan is provenance); job succeeds unless result status
  is `failed`.
- Server pings Docker every 5 s; on reachable again → orphan cleanup + pump; broadcasts `runner.status`.
- New deps (step 3): dockerode, @types/dockerode, tar-stream, @types/tar-stream — newest ≥ 2 weeks old.

## Notes from step 1

- Files: `shared/src/tools.ts` (TOOL_MODES, JOB_STATUSES, scopeModeFor), `server/src/runner/{defs,runtime,spec}.ts`,
  `server/test/fakeRuntime.ts`, `server/test/runner-spec.test.ts`.
- FakeRuntime: `behave(spec)` → `{ files, stdout, stderr, exitCode, hang, delayMs, startError }`; `created` keeps
  every spec ever created (removed ones too); `calls` records ops; `reachable = false` makes every op throw;
  `addImage(ref)` needed before `create`.
- The guard test's "runner file may import Docker" test still reads the config only; switch it to linting the
  real `docker.ts` in step 3.

## Next action

Step 2: write migration `0004_jobs` (hand-written SQL + drizzle schema in `server/src/db/schema.ts`; tables only,
not breaking; check `pnpm --filter @redwhale/server db:generate` reports no drift), then
`server/src/runner/orchestrator.ts` with the fake runtime: enqueue (authorize at queue) → pump (cap, authorize at
start, containerSpec, create/start/wait/timeout-kill, cancel) → recover() on start. Ingest/raw storage is step 9;
in step 2 the finish path can just record exit code + remove container/volume.
