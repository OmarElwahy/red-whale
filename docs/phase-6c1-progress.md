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
| 2 | `0004_jobs` migration (jobs, runner_state) + orchestrator queue + concurrency + scope-change cancel + restart/orphan handling (fake runtime) | done |
| 3a | `docker.ts` (dockerode) + catalog loader + 4 tool.json + group.json + Dockerfile + `.dockerignore` + Python helper (+ unittest, run by Vitest) + `pnpm tools:build` — all tested without Docker | done |
| 3b | Build the image with Docker (`pnpm tools:build`), fix what the real build shows, check hardening in a real container. Needs Docker Desktop | done |
| 4 | subfinder script + anonymized real fixture + expected.json | done |
| 5 | assetfinder (same) | done |
| 6 | findomain (same) | |
| 7 | crt.sh (same; retries unit-tested in Python) | |
| 8 | `pnpm tools:check <tool\|--all>` (tools/check.py + TS wrapper), Vitest runs it for every tool | |
| 9 | job execution → ingest → raw output storage (fake runtime). The real-Docker integration test moved to 3b | done (out of order: 3b–7 blocked on Docker + domain) |
| 10 | API + WS (`job.updated`, `runner.status`), group jobs | done (out of order) |
| 11a | UI: API hooks (web/src/api/runner.ts), live split, Run tool submenu, header runner chip, run notices | done (out of order) |
| 11b | UI: Jobs tab (status, duration, +N new/M updated, cancel, raw output, Show results), provenance raw link | done (out of order) |
| 12 | Docs: architecture.md (new §12 Orchestrator, §4, §6, §9, decisions log), team-guide.md rewrite, group README, handoff.md | |

## Decisions (approved plan + user's answers)

- **Fixture capture (steps 4–7):** run the four tools myself, in Docker (the built image), against
  **the domain the user gave on 2026-11-02** (a bug-bounty target they are authorized on; all four tools are
  passive). It is NOT written in the repo (public): it is in local Claude memory (fixture-capture-domain.md);
  if that is missing, ask the user. Grep the repo for it before every commit. The repo is public: **never commit real hostnames**. After capturing, keep each file's
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

## Notes from step 2

- `jobs.id` is an **integer** (autoincrement; readable "job 12"). Container/volume name
  `redwhale-<workspace id first 8>-job-<id>` (`resourceName` in spec.ts), so two workspaces' job 12 don't collide.
- Migration `0004_jobs` (drizzle-generated + a header comment + the `runner_state` insert with
  `lower(hex(randomblob(16)))`). Not breaking. `db:generate` reports no drift. db.test.ts: migration count 5, an
  upgrade test (0003 db with data → 0004), CHECKs.
- `wipeWorkspace` (mock/cli.ts) deletes `jobs` first. **TODO step 9:** the mock CLI must also remove `<db dir>/jobs/`.
- `Orchestrator` (`server/src/runner/orchestrator.ts`): `enqueue(tool, nodeId)`, `enqueueGroup(group, nodeId)` →
  `{ ok, jobs }` or `{ ok:false, code: unknown-tool|unknown-group|unknown-node|wrong-type|refused }` (refused carries
  the stored refused jobs). `cancel(id)`, `onScopeChanged()`, `pump()`, `idle()`, `recover()`, `cleanupOrphans()`,
  `checkRunner()` (ping; first ping or coming back → orphan cleanup + pump; `onRunnerChange` on change),
  `startMonitor(ms)`, `stop()`, `counts()`, `pending()`, `get(id)`. Options: `finish` hook (step 9 plugs ingest in;
  default `exitCodeOnly`), `onJob` (→ WS job.updated in step 10), `timeoutMs(def)` (tests shorten), `now`.
- `ToolCatalog` interface `{ tool(name), group(name), imageRef(group) }`; step 3 implements it from tools/ on disk.
- On timeout the finish hook still runs (the script may have written a partial result), then the job is forced to
  `failed` with "timed out after N s; the container was killed" (+ the hook's error).
- `stop()` = shutdown: no more starts, and running jobs are **abandoned** (row stays `running`, container left);
  the next start's `recover()` fails them and removes the containers, same as after a crash.
- Pump is skipped while the last ping said Docker is unreachable (jobs stay queued); before the first ping it runs.
- Tests: server/test/orchestrator.test.ts (13), with the fake runtime.

## Notes from step 3a (step 3 split: Docker Desktop wasn't running)

- Deps: `dockerode` 5.0.1, `tar-stream` 3.2.2 (ships its own types; no @types/tar-stream), `@types/dockerode` 4.0.2
  (dev). pnpm ignored build scripts of cpu-features / ssh2 / protobufjs (optional, unused with the named pipe):
  left unapproved on purpose.
- `docker.ts`: `DockerRuntime` (ping+version, inspect/list images, create = createVolume + createContainer({name,
  ...spec.body}), start, wait, kill SIGKILL, logs demuxed (`demuxLogs`), fetchOutput via getArchive +
  `readOutputArchive` (top-level files only, per-file caps by tar header size, total cap aborts the read, skipped
  files reported with sizes), remove container (force, v) / volume, list by label, `build()` via buildImage
  `{context, src}` + followProgress). 404/304/409 treated as done for kill/remove.
- `catalog.ts`: `loadCatalog(dir = tools/)` → `Catalog` (implements ToolCatalog; `info(group)`, `tools()`), throws
  `CatalogError` with every issue. Build context = `.dockerignore`, `validate_output.py`, `lib/**`, `<group>/**`
  minus what `inBuildContext` drops (fixtures/, tests/, __pycache__, test_*.py, README.md, NOTE.md, *.pyc) —
  mirrors `tools/.dockerignore`. Image ref `<group.image>:<sha256 of context>[0:12]`, labels `redwhale.group`,
  `redwhale.context`. `imageStatus(runtime, info)` → built | outdated | missing | unknown.
- Python: `tools/lib/redwhale_tool.py` (ToolRun.add/add_subdomain/error/run_command/write, json_lines, clean_host,
  safe_target, main(tool, parse, command=|fetch=, version_command=)). Imports `tools/validate_output.py` (one set
  of rules; copied to /opt/redwhale/ in the image). Scripts run with `python3 -I`, so run.py must put
  `<tools>/lib` on sys.path itself (parents[2] / "lib"). `argparse` already refuses `--target -x`; `--target=-x`
  is refused by safe_target (exit 2, nothing written). `tools/lib/fetch_release.py` = Dockerfile download +
  sha256 check + extract (build time only).
- Dockerfile: classic builder (no BuildKit heredocs/`# syntax`; dockerode's buildImage without `version: 2`).
  Base `python:3.13-slim-trixie@sha256:ae14d4ce…` (digest of 2026-11-02). subfinder v2.17.0 (sha256 matches its
  checksums.txt), assetfinder v0.1.1 (sha256 computed by me 2026-11-02: a7c61fe7…), findomain 10.0.1 (stable;
  11.0.0 is beta). amd64 only. User 10001, /out owned by it.
- Python unit tests: `server/test/tools-python.test.ts` runs `python -I -m unittest discover -s <dir>` for every
  folder under tools/ with a test_*.py (unittest discover needs -s per folder: no __init__.py files).
- tool.json timeouts: subfinder 600, assetfinder 300, findomain 600, crtsh 420 s.

## Notes from step 9 (done before 3b–8: Docker Desktop not running, domain still `<DOMAIN>`)

- `server/src/runner/finish.ts`: `ingestFinish({ db, jobsDir, onIngested })` is the FinishHook the server will use.
  Saves `<jobsDir>/<id>/{stdout.txt, stderr.txt, raw.txt, result.json}`; caps: RAW 5 MB (truncated + note),
  result.json ≤ 50 MB (over → failed, never truncated), total read 56 MB. Notes (truncation, ignored files with
  sizes, over-limit) go into `jobs.error` even on success. Checks the result's `tool` equals the def name before
  ingest. Ingest `invalid` → failed + `issues`; `duplicate` → succeeded, existing scanId, 0/0 counts + note;
  `ingested` → `nodesCreated` = created.nodes, `nodesUpdated` = touched − created; result status `failed` → job
  failed but scan linked; `partial` → succeeded with "partial result: …". `jobsDirFor(dbPath)` = `<db dir>/jobs`.
- Mock CLI removes `jobsDirFor(dbPath)` after the wipe (test in mock.test.ts).
- Orchestrator's final row update is wrapped: a mock wipe during a run no longer crashes the server.
- Tests: `server/test/finish.test.ts` (9): link + counts + files, **two tools → corroborated node and edge**, invalid
  → issues, tool mismatch, no result / not JSON, tool-reported failure, partial + duplicate, size caps, timeout
  with a partial result.

## Notes from step 10

- Schemas in `shared/src/api.ts` (section "tool runs"): `toolInfoSchema`, `toolGroupInfoSchema`, `toolsResponseSchema`,
  `jobSchema` (= jobs row minus containerId; `group` = tool_group), `jobsQuerySchema` (page, pageSize ≤ 200, status
  csv, nodeId), `jobsResponseSchema`, `jobDetailResponseSchema` ({ job, tails: {stdout, stderr, raw} }, last 4 KB,
  "…" prefix when cut, null when no file), `jobCreateSchema`, `groupJobCreateSchema`, `jobsCreatedResponseSchema`,
  `jobRefusedResponseSchema` (403: { error, decision, jobs }), `runnerStatusSchema`, `IMAGE_STATUSES`,
  `JOB_OUTPUT_STREAMS`. WS: `job.updated { job }`, `runner.status { reachable, error }`.
- `jobId` (nullable; MIN(jobs.id) for the scan) added to node-detail observations, edge-detail observations and
  `GET /scans` items. Web test fixtures updated (`jobId: null`).
- `server/src/routes/jobs.ts`. POST order: body → tool 404 → node 404 → type 400 → fresh ping 503 → image status
  409 ("run pnpm tools:build <group>"; says "out of date" for outdated) → orchestrator.enqueue (authorize, logged)
  → 201 / 403. 409/503 store no job and log no decision. Cancel: 200 { job } | 404 | 409.
  `GET /jobs/:id/output/:stream` = text/plain; charset=utf-8, inline, nosniff.
- `buildApp({ runner: { runtime, catalog, jobsDir, maxJobs?, timeoutMs? } })` builds the Orchestrator (finish =
  ingestFinish, broadcasting scan.ingested + graph.updated like POST /ingest), exposes it as `app.orchestrator`
  (Fastify decorate; null without runner → the routes answer 503), stops it on close. `RouteContext.orchestrator`;
  scope routes call `orchestrator?.onScopeChanged()` on every change.
- run-server.ts: `loadCatalog()` (a CatalogError is printed and the runner is OFF; the graph still works),
  `DockerRuntime()`, `jobsDirFor(dbPath)`, `REDWHALE_MAX_JOBS` (default 2); `recover()` then `startMonitor()`
  before listen.
- **For step 11:** `web/src/api/live.ts` invalidates every `api` query on ANY event; `job.updated` comes ~4× per
  job, so it must only invalidate jobs/runner/tools queries (and `runner.status` only runner/tools), not the graph.
- Tests: `server/test/api/jobs.test.ts` (12).

## Notes from step 11a

- `web/src/api/runner.ts`: `useTools`, `useRunnerStatus` (polls 15 s), `useJobs(page)`, `useJob(id)`, `startRun` /
  `useStartRun` (403 → `RunRefused` with the reason and refused jobs), `useCancelJob`, `outputUrl(id, stream)`.
  Query keys under `['api','runner', …]` (`queryKeys.runner/tools/runnerStatus/jobs/job`).
- live: `job.updated` / `runner.status` → only `queryKeys.runner` + `queryKeys.scopeLogAll` (own Coalescer); other
  events unchanged (everything). Test in web/test/live.test.ts.
- Menu (`web/src/menu/items.ts`): action `run-menu` with `submenu` (from `runItems(node, RunContext)`), items
  `run-group` / `run-tool` with `name` and `badges` ({text, tone: mode|external}). Disabled reasons in order:
  Docker down → image missing/outdated → passive-only (active/intrusive) → n/a → not in scope (node.inScope, the
  passive decision). Groups/"more" nodes get no Run tool item any more (was a disabled placeholder).
  `ContextMenu` opens a submenu in place ("‹ Run tool" goes back), shows badges and, in the submenu, the reason
  under disabled items; `onAction(item)` (was `action`).
- App: `runContext` from useTools/useRunnerStatus/useScopeSettings; `run(action, target, name?)` handles
  run-tool/run-group via useStartRun; result in the header notice (`ui.showNotice`): "subfinder on example.com:
  queued 1 job" / "… refused: <reason>" / "… failed: <error>". `RunnerIndicator` (web/src/jobs/) in the header:
  green Docker / amber (images not built) / red Docker off / grey runner off, with running(+queued) count.

## Notes from step 11b

- `BottomPanel` has `'jobs'`; `ui.openBottomPanel(panel)` (open, never toggle), `ui.highlightScanId` +
  `setHighlightScan`. Header: "Jobs (N)" toggle (running + queued), next to Scope. A queued run opens the Jobs tab.
- `web/src/jobs/JobsPanel.tsx`: 25 per page newest first; status badge (error as title), tool, target (button →
  pick the node, clears the highlight), started, duration (ticks each second while a job runs), Found
  (`jobFindings`: "+14 new, 6 updated" / "nothing new" / "–"), actions Cancel (queued/running), Raw output
  (dialog: argv, error, validation issues, tabs raw/stderr/stdout with the 4 KB tails from GET /jobs/:id and
  "open full <stream>" links), Show results (scanId set: highlight that scan + pick the target node).
- ProvenanceTable: rows with `jobId` get a "raw output" link (new tab); the highlighted scan's row has
  `aria-current` and a tint. SidePanel reads `highlightScanId` from the store.
- Tests: web/test/jobs-panel.test.tsx (11), panel.test.tsx (+1). Not checked in a real browser yet (no Docker
  here); include in the manual checks.

## Notes from step 3b

- Docker Desktop 29.7.2 (linux/amd64). `pnpm tools:build subdomain` built `redwhale-tools/subdomain:f8064792eb65` in
  42 s with the classic builder, first try (dockerode's default pipe `//./pipe/docker_engine` works).
- Verified in a container (--read-only, cap-drop ALL): uid 10001, Python 3.13.18, subfinder (prints config dir to
  stderr; `-version`), assetfinder, findomain 10.0.1; /opt/redwhale has no fixtures/tests; `/out` owned by 10001;
  root fs read-only.
- Git Bash gotcha: `docker run --tmpfs /tmp` → set `MSYS_NO_PATHCONV=1` or the path gets mangled.
- `server/test/docker.integration.test.ts` (skipIf no Docker / no image): hardening via `docker inspect`, /out read
  from the volume after exit, per-file caps + skipped files, demuxed logs, cleanup; through the Orchestrator +
  ingestFinish: succeeded + ingested, timeout → 137 + failed, nothing left (labels with a per-test workspace id).
  Test tools are `python3 -c` (no braces allowed in argv items, so `dict(...)` not `{...}`).

## Notes from step 4

- Captures + the anonymizer live in the session scratchpad only (`anon.py`: REAL → `northwind.example`, one mapping
  in `mapping.json` shared by all tools so the same real host gets the same fake name in every fixture; common labels
  kept, others → made-up words; other real domains → `<word>-corp.example`). Before every commit:
  `grep -rli <real domain> tools server web docs shared` must print nothing.
- subfinder command: `subfinder -d <t> -oJ -cs -silent -duc -max-time 8` (-cs = all sources per host; -duc = no
  update check; -max-time 8 min < 10 min kill; no -nW: resolving isn't passive). Output lines
  `{"host","input","sources":[…]}`; data = `{"sources": sorted}` (merged across duplicate lines).
- Real capture: 550 hosts, no wildcard/uppercase/dot/dup/apex lines → fixture = 50 real lines + 8 edited copies for
  those cases (documented in NOTE.md). Replay: 50 findings, 3 ignored, status success.
- Fixture convention (all tools): `fixtures/raw.<ext>` (exactly one raw.*), `fixtures/expected.json` =
  `{ target: "northwind.example", status, errors, findings (sorted by type,value) }`, `fixtures/NOTE.md` required.
  `server/test/tools-fixtures.test.ts` replays every tool with fixtures and checks Zod validity, tool/target/status/
  errors, findings (order-insensitive) and that raw.txt == the fixture.
- Real run in the image (rebuilt: `redwhale-tools/subdomain:010e067e627a`): tool_version 2.17.0 detected, success.
  Note: every rebuild leaves the previous image tag behind (`docker image prune`-able; maybe tools:build should
  remove older images of the group — later).
- The real domain had been written into this file in the 3b commit (pushed). Removed now; it remains in git
  history (6d4e44b). Told the user.

## Notes from step 5

- assetfinder has no JSON mode and no version flag: text parser (one host per line), `VERSION_COMMAND = None`
  (v0.1.1 pinned in the Dockerfile). Command `assetfinder --subs-only <t>`; suffix-only match, so add_subdomain()
  drops look-alikes. Real capture: 27 lines incl. the apex (~1 s; most of its sources are dead or need keys; a later
  run gave 30). Fixture = all 27 + 7 edited edge-case lines; replay: 26 findings, 3 ignored. Same fake mapping as
  subfinder (www/api/mail/pine/cobalt/… overlap → corroboration across fixtures).
- Image now `redwhale-tools/subdomain:5f11224f200a`.

## Next action

Step 6 (findomain): check `findomain --help` for a machine-readable/quiet mode (`-q` quiet prints hosts only;
there is no JSON output in 10.0.1 as far as known — confirm), no update check / no external DB, and a run timeout
flag. Capture in the image (hardened, `MSYS_NO_PATHCONV=1`), write `tools/subdomain/findomain/run.py`, anonymize
with scratchpad `anon.py`, ~50 lines + edge cases, NOTE.md, expected.json from a replay (review), rebuild, real run,
checks, grep for the real domain, commit "6C-1 step 6".
