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
| 2 | The auto-check scheduler + tests (fake runtime) | next |
| 3 | The Takeover watch tab + the "Auto takeover checks" setting + the Jobs trigger badge | |
| 4 | Docs + manual checklist | |

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

## Next action

Step 2: `server/src/takeover/scheduler.ts` (tick: setting on + Docker reachable + dns image built; due = in scope by an
unlogged pre-check, no takeover-check scan or auto job in 24 h, nothing queued/running; queue up to
`REDWHALE_AUTO_MAX_QUEUED` minus queued auto jobs, through `enqueue(..., { trigger: 'auto' })`); orchestrator `pump()`
manual first; triggers (start, ingest touching subdomains, 24 h timer, Docker back, an auto job finishing); setting off
cancels queued auto jobs. Tests with the fake runtime and an injected clock.
