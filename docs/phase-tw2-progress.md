# Phase TW-2 progress: Takeover watch (second half)

Branch `phase-tw2`, from `phase-tw1`'s tip (TW-1 isn't merged yet; the user merges the stack after their manual
checks). Checkpoint method: each step ends green (`pnpm typecheck` + `pnpm test`), then this file, a commit
`TW-2 step N: <what>` and a push. Never merged to main by Claude.

Scope: a bottom-panel tab listing every subdomain's takeover status and expiry, kept fresh by automatic passive
takeover-check runs. Not in scope: HTTP fingerprints, TLS expiry, other automation (6D).

## Steps

| # | Step | State |
|---|---|---|
| 1 | Migration 0007 + the watch query and `GET /api/takeover/watch` + tests | done |
| 2 | The auto-check scheduler + tests (fake runtime) | done |
| 3 | The Takeover watch tab + the "Auto takeover checks" setting + the Jobs trigger badge | done |
| 4 | Docs + manual checklist | done |

## Decisions (from the plan review)

- **No stored watch table.** Rows are built on read, from each subdomain's **latest takeover-check scan** (by
  `scans.tool` + normalized `scans.target`; so files ingested by hand count too), read through per-scan provenance
  (`observations`, `edge_observations`): an older chain or registration never leaks into a row.
- **Weakest link.** The status weighs every domain the check looked up (own + external). `registration` is the one that
  sets it: not registered → expiring (soonest) → unknown → fine (soonest expiry). `registrations` lists all of them
  (the UI's tooltip). The chain-end column is always the real chain end (the subdomain itself without a CNAME).
- **Status order:** `takeable` (an open takeover vulnerability: observed in the latest check, node not tagged
  `ignored`) → `expiring` (registered, days left < 90, already-expired included: negative days, sorted first) →
  `unknown` (scan partial/failed, a registration `null`, or none) → `ok` → `not-checked` → `out-of-scope`.
  Days left colours: < 30 red, < 90 amber.
- **Out of scope:** a subdomain checked earlier keeps its last status with `inScope: false` ("out of scope, not
  refreshed" + its last-checked date). Only never-checked out-of-scope subdomains are `out-of-scope`.
- **Failures:** the latest finished takeover-check job, if it failed after the latest scan was ingested, is the row's
  `lastFailure` ("last check failed: <reason>"). A failed auto job is retried after 24 h, like a success; manual runs
  are never blocked by it.
- **Scheduler (step 2):** also refills when an auto job finishes (otherwise 400 subdomains at 10 queued would take
  days), always within `REDWHALE_AUTO_MAX_QUEUED` and behind manual jobs.

## Step 1 (done)

- **Migration `0007_takeover_watch` (not breaking):** `jobs.trigger` (`manual`|`auto`, NOT NULL DEFAULT `manual`,
  `jobs_trigger_ck`): drizzle-kit rebuilds `jobs`; its generated copy selected the new column from the old table, so
  `"trigger"` was removed from both column lists by hand (existing rows take the default). `scope_settings.
  auto_takeover_checks` (default on). Index `scans_tool_target_idx`. Test: a 0006 database with a job upgrades (job
  kept as `manual`, ids continue, CHECK works, settings row on, indexes there).
- Shared: `JOB_TRIGGERS`; `jobSchema.trigger`; `scopeSettingsSchema.autoTakeoverChecks`; the settings PATCH takes
  either field (at least one); `TAKEOVER_STATUSES`, `TAKEOVER_EXPIRING_DAYS` (90), `TAKEOVER_RED_DAYS` (30),
  `takeoverWatchRowSchema`, `takeoverWatchQuerySchema` (100 per page, max 500), `takeoverWatchResponseSchema` (items,
  paging, counts per status, server `now`).
- Server: `server/src/takeover/watch.ts` (`takeoverWatchRows`, `takeoverWatch`, `daysLeft`), bulk queries (no query per
  subdomain); `GET /api/takeover/watch`; `jobDto` has `trigger`; `setSettings` takes a partial patch (a missing
  settings row reads as auto checks **off**, the safe side).
- **Every subdomain is a row**, including chain hops outside the scope (e.g. `x.azurewebsites.net`), which show as
  `out-of-scope` at the bottom.
- Vulnerability nodes are shared by ID (`takeover-unregistered-domain` is one node), so tagging it `ignored` closes it
  on every row; "open" per row is "observed in that row's latest check".
- Tests: `server/test/takeover-watch.test.ts` (13: order, weakest link, own domain expiring, days left, unknown, chain
  from the latest scan only, private-suffix service, out of scope, ignored vuln, a later clean check closes it,
  lastFailure/pending, paging/counts, the API against Zod); settings API test; db migration test.

## Step 2 (done)

- `server/src/takeover/scheduler.ts`, `TakeoverScheduler`:
  - `tick()`: setting off → cancels the queued auto jobs (`auto takeover checks were turned off`) and stops. Else, only
    with takeover-check in the catalog, Docker reachable (last ping) and its image built (`inspectImage`): no job row
    and no scope decision otherwise, like a manual run. Then queues `due()` subdomains until `maxQueued` auto jobs are
    queued, each through `enqueue(..., { trigger: 'auto' })` (authorize() + log, and again at the start).
  - `due()`: subdomains in scope by an unlogged `compileScope` pre-check (like `onScopeChanged`), without a
    takeover-check scan finished in the last 24 h, a queued/running takeover-check job (any trigger), or an auto job
    created in the last 24 h (any outcome, failed included: retried after 24 h). Auto jobs cancelled by turning the
    setting off don't count, so turning it on again queues them at once. Order: never checked, then oldest check.
  - Ticks never overlap (`poke()` during a tick → exactly one more after it). Idle until `start()`: `buildApp` creates
    it (so app tests get no auto jobs), `run-server` starts it after `recover()` + `startMonitor()`.
  - Triggers, through a new server-side `Broadcaster.listen()`: `graph.updated` (any ingest, upload, manual add),
    `scope.changed` (rules and settings), `job.updated` of an auto job reaching a final status (the refill),
    `runner.status` reachable; `start()`; a 24 h `setInterval` (unref'd).
- Orchestrator: `EnqueueOptions.trigger` (default `manual`), `cancelQueued(trigger, error)`, and `pump()` orders
  queued jobs manual first, then by id. A running auto job is never stopped for a manual one.
- `REDWHALE_AUTO_MAX_QUEUED` (`autoMaxQueued()`: a positive integer, else 10) → `RunnerOptions.autoMaxQueued`.
- Tests: `server/test/takeover-scheduler.test.ts` (11: due order and skips, failed attempt retried after 24 h, the
  cap, no rows/logs without Docker or image, out of scope never queued, manual first, setting off/on, start(), the
  refill until all five are checked, which events poke, the env parsing); `api/jobs.test.ts` (2: an upload queues auto
  jobs and PATCH settings off cancels the queued ones over the real app; nothing before `start()`).

## Step 3 (done)

- `web/src/takeover/TakeoverPanel.tsx`, bottom panel `takeover` ("Takeover watch" button, between Scope and
  Deleted): status counts (non-zero only), paging (100 per page), a table: Subdomain (+ notes: "out of scope, not
  refreshed", "last check failed: <reason>" in red, "checking…"), Status ("takeable now" with the vulnerability names
  as its title, "not checked (out of scope)"), Chain end (the full chain as its title; "(x service)" for a private
  suffix), Domain (the weakest link; tooltip: every domain looked up with its state, source and reason; "+N"), Registered,
  Expires (date), Days left (< 30 red, < 90 amber), Last checked (UTC, "(partial)"/"(failed)"). A click anywhere on a
  row picks the node with App's `pick` (the table view's: select + open the path); the selected row is marked.
- `web/src/api/takeover.ts` (`useTakeoverWatch`); the query key `['api', 'runner', 'takeover', page]` sits under
  `runner`, so `job.updated` refetches it as well as `graph.updated` / `scope.changed` (which refetch everything).
- Scope panel: `SettingSwitch` (the passive-only switch, made generic) + "Auto takeover checks" (PATCHes only its own
  field). Jobs tab: an `auto` badge (sky) after the tool name.
- Tests: `web/test/takeover-panel.test.tsx` (4), the badge in `jobs-panel.test.tsx`, the switch in
  `scope-panel.test.tsx`. Not checked in a real browser in this step: that's in the manual checklist (step 4).

## Step 4 (done)

- architecture.md: §4 (`scans` index, `scope_settings.auto_takeover_checks`, `jobs.trigger`, migration 0007), §6
  (`GET /takeover/watch`, settings PATCH), §8 (bottom panel list, the Takeover watch tab, the `auto` badge, the
  switch), §9 (TW-2 done; fingerprints/TLS expiry later), §11 (queue order; "Takeover watch" and "Automatic checks"
  sections), §13 (6 rows dated 2026-11-23). CLAUDE.md: `REDWHALE_AUTO_MAX_QUEUED`. handoff.md: status, TW-2 row, key
  decision, open items (merge order; fingerprints/TLS expiry; external hops as rows).

## Manual check (PowerShell, from the repo root)

**Read first:** on this branch, the server queues passive takeover-checks **by itself** as soon as it starts, on
every in-scope subdomain not checked in the last 24 h (setting "Auto takeover checks", default on). They only ask
your system DNS resolver and RDAP/WHOIS servers, never the subdomains themselves, and each one goes through the scope
guard. If you don't want that on your real database yet, start on a copy (step 3).

**Setup** (proves: migration 0007 keeps your data; nothing else changed in the tools):

1. `git switch phase-tw2`, then `pnpm install`.
2. `pnpm tools:build dns`: nothing under `tools/` changed since TW-1, so it prints `✓ dns: … is up to date` (or
   builds it if you haven't since TW-1).
3. Optional, to try it on a copy (with `pnpm dev` stopped, so the copy is complete), in its **own folder** (job outputs go to `jobs\` next to the database, so a copy in
   `data\` would share job folders with the real one): `New-Item -ItemType Directory data\tw2-copy`, then
   `Copy-Item data\redwhale.db data\tw2-copy\redwhale.db`, then `$env:REDWHALE_DB = "data/tw2-copy/redwhale.db"`
   (remove it afterwards with `Remove-Item Env:REDWHALE_DB`).
4. `pnpm dev`: no "Database is from an older schema" message; the graph, your old jobs and their results are all
   still there. Old jobs have **no** `auto` badge (they became `manual`).

**Automatic checks** (proves: they start by themselves, stay capped, refill, run behind your own jobs):

5. Within a few seconds the Jobs tab fills with takeover-check jobs with a sky-blue **AUTO** badge: at most 2 running
   (`REDWHALE_MAX_JOBS`) and at most **10 queued**. As each finishes, another is queued, until every in-scope
   subdomain was checked once. Out-of-scope subdomains never get a job (and no `run` entries for them in the Scope
   log).
6. While auto jobs are queued, run any tool by hand (right-click ▸ Run tool): it starts as soon as a running job
   finishes, **before** the queued auto jobs. Nothing running is stopped for it.
7. Scope panel ▸ **Auto takeover checks** off: every queued auto job becomes `cancelled` ("auto takeover checks were
   turned off"); the running ones finish normally; no new auto job appears. Turn it on again: the queue fills again
   with the subdomains that were cancelled.
8. Stop `pnpm dev` and start it again (on Windows, check that no old vite is left on :5173): subdomains checked in
   the last 24 h get **no** new auto job.
9. Optional: `$env:REDWHALE_AUTO_MAX_QUEUED = "3"`, restart: at most 3 auto jobs queued at once. Remove it afterwards
   (`Remove-Item Env:REDWHALE_AUTO_MAX_QUEUED`).

**The Takeover watch tab** (proves: rows from the latest check, ordering, live refresh, the row click):

10. Header ▸ **Takeover watch**. The counts list the statuses present. Rows are ordered: takeable now (red) →
    expiring (soonest first, already expired on top) → unknown → ok → not checked → not checked (out of scope).
    External chain hops (e.g. `x.azurewebsites.net`, `*.outlook.com`) show at the bottom as "not checked (out of
    scope)".
11. While auto jobs run, rows show "checking…" and change status without a reload when their job finishes.
12. A subdomain with a CNAME to a third party: Chain end = the last name of the chain (the full chain as its tooltip;
    "(… service)" for a cloud name); Domain = the weakest link. Hover Domain: one line per domain looked up (your own
    domain and each external one) with registered/expiry/days and source (rdap/whois). Days left is red under 30,
    amber under 90, plain otherwise. A subdomain without a CNAME: Chain end = itself, Domain = your own domain.
13. Click a row (anywhere): the graph selects that subdomain and opens the groups down to it, like a Table row.
14. Scope panel: add an **exclude** rule for one subdomain that is already checked: its row keeps its status, with
    "out of scope, not refreshed" and its last-checked date; no new auto job for it later. Remove the rule afterwards.
15. Run Takeover check by hand on a subdomain again: the row's Last checked moves to now (the latest scan wins).

## Next action

All four steps are done and pushed. Waiting for the user's manual check (above), after 6C-4's and TW-1's; the user
merges `phase-6c4`, then `phase-tw1`, then `phase-tw2`. Nothing after TW-2 is started.
