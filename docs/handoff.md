# RED WHALE — Context Handoff

Paste this file into a new chat to continue where we left off. It holds the context that isn't in the
other docs. Source of truth for design details is still `docs/architecture.md` (incl. the decisions log, §13),
`docs/contract.md` and `CLAUDE.md` — attach `docs/architecture.md` too if the question is technical.

_Last updated: 2026-11-24_

## Who / what

- **Project:** RED WHALE — local, free, open-source recon framework. Tool findings → correlation graph
  (domain → subdomain → IP → port → URL → tech → vuln). DEPI graduation project.
- **Me:** team leader. **Claude Code builds the core** (contract, database, API, graph UI) **and the orchestrator**;
  I plan, review and check by hand.
- **Team:** teammates write the scripts for the other tool groups by **copying the subdomain group template**
  (`tools/subdomain/`, one folder per tool: `tool.json`, `run.py`, `fixtures/`) and following `docs/team-guide.md`.
  Before handing in, each script must pass `pnpm tools:check <tool>` (no network). Their real scripts haven't been
  tested end to end yet.
- **My machine:** Windows laptop (16 GB RAM), PowerShell (no `&&`; run commands one by one or use `;`), Docker Desktop
  (WSL2). Repo at `D:\DEPI\Technical\Red Whale`, on GitHub at **github.com/OmarElwahy/red-whale**. Logos/flowchart in `assets/`.

## Stack (locked)

TypeScript (pinned 6.0.x) · pnpm monorepo `shared/` `server/` `web/` · Zod · Fastify + WebSocket on
127.0.0.1:4100 · SQLite via better-sqlite3 + Drizzle · Vite + React on 127.0.0.1:5173 · Cytoscape.js + fcose ·
elkjs (Tree layout, Web Worker) · Zustand · TanStack Query + Table · Tailwind + shadcn/ui · react-markdown · Vitest ·
`lucide-static` (node icons) · `tldts` (Public Suffix List, scope guard) · `dockerode` + `tar-stream` (Docker runner,
only in `server/src/runner/docker.ts`) · Python stdlib tool scripts in containers.
Dropped: `cytoscape-expand-collapse` (groups are server-side).

## Status

Main has everything through 6C-3. 6C-4 is on branch `phase-6c4`, TW-1 on `phase-tw1` (from `phase-6c4`'s tip) and
TW-2 on `phase-tw2` (from `phase-tw1`'s tip) and 6C-5 on `phase-6c5` (from `phase-tw2`'s tip); all on GitHub, **not
merged** until my manual checks (checklists in `docs/phase-6c4-progress.md`, `docs/phase-tw1-progress.md`,
`docs/phase-tw2-progress.md` and `docs/phase-6c5-progress.md`).

| Phase | What | Status |
|---|---|---|
| 1–4 | Monorepo + contract + IDs; SQLite + idempotent ingest + confidence; mock data + API + server-side aggregation; graph UI, side panel, provenance, tags/notes | ✅ done |
| 5A | Filters, search, URL state, N-hop focus, mute low-risk | ✅ done |
| 5B | Synced table, WebSocket live updates, Highlights, JSON/PNG export | ✅ done (on main) |
| 5C | Graph polish: edges/labels, momentum, smooth zoom, Force/Tree layouts, showcase mock (`pnpm mock`) | ✅ done (on main) |
| 6A | Scope guard: rules, `authorize()`, scope API + log, Scope panel, out-of-scope hatch | ✅ done (on main) |
| 5D | Icons per node type + collapsible groups (`POST /graph/view`, `GET /graph/path`) | ✅ done (on main) |
| 6B | Edge provenance: `edge_observations`, edge confidence, edge side panel, thicker corroborated edges | ✅ done (on main) |
| 6C-1 | Orchestrator (hardened containers, SQLite job queue, scope re-check before each start, Jobs tab, Docker chip) + subdomain enumeration group: subfinder, assetfinder, findomain, crt.sh; `pnpm tools:build`, `pnpm tools:check` | ✅ done (on main) |
| Edit | Graph editing: add nodes by hand (tool `manual`), permanent delete (node / subtree / group) with a "Deleted" log | ✅ done (on main) |
| 6C-2 | First active tool: tools network `redwhale-tools`, local lab `lab.redwhale.test` (`pnpm lab:up/down/status`), 428 + confirmation dialog for active runs, `http` group with httpx (never follows redirects); `{targetType}`, `contacts`, `tech_value` | ✅ done (on main) |
| 6C-3 | `dns` group with dnsx (passive: A/AAAA/CNAME through the system resolver, never brute-force) and `ports` group with naabu (active, IPs only: connect scan of the top 100 TCP ports, no capability); lab also on 8080; tools that resolve names refuse to run without a system resolver | ✅ done (on main) |
| 6C-4 | nmap in the `ports` group (active, an ip or a port: connect scan + `-sV`, no other scripts/OS/UDP; Debian-pinned package); lab answers on TCP 22 with a fake SSH banner; typed command builders `command(target, target_type)` | ✅ done · manual check pending (checklist in `docs/phase-6c4-progress.md`) |
| TW-1 | Takeover watch, first half: relation `cname_to` (+ migration 0006, rows kept); bundled PSL + RDAP bootstrap (`pnpm tools:refresh-data`), `tools/lib/psl.py` = tldts on shared vectors; `takeover-check` in `dns` (passive: CNAME chain via dnsx, RDAP / WHOIS registration, `takeover-unregistered-domain` critical, `takeover-dangling-cname` medium; transcript replay) | ✅ done · manual check pending (checklist in `docs/phase-tw1-progress.md`) |

| TW-2 | Takeover watch, second half: a "Takeover watch" tab (one row per subdomain, built on read from its latest takeover-check: status, chain end, weakest-link registration, days left, last checked), automatic passive checks (24 h, capped queue, manual first, setting in the Scope panel), `auto` badge in Jobs; migration 0007 (rows kept) | ✅ done (branch `phase-tw2`, awaiting my check) |
| 6C-5 | `urls` group (URL discovery): gau (passive, domain/subdomain: Wayback, Common Crawl, OTX, one run per provider so each URL's source is known, target host only, `serves`, ≤ 5,000, a failed provider → partial) and katana (active, url: same host only, depth 2, links + JavaScript, GET only, no redirects, no `-kf`, `has_url` from the page it was found on); one static-extension list; lab crawl site; no contract change | ✅ done (branch `phase-6c5`, awaiting my check) |
| 6C-6 | `vuln` group (vulnerability scanning): nuclei (active, url) with pinned templates v10.5.1 baked in, HTTP only, tags cve/misconfig/exposure/tech/takeover minus intrusive/dos/fuzz/bruteforce/default-login/osint/ssrf/oast/proxy (~6,500 templates, ~11,000 requests at 5/s, `-mt 55m` in a 3600 s job), `-ni -dr -duc`, no outside contact; `tech` → technology, the rest → vulnerability (CVE or template ID) under the matched URL; extracted values masked; lab fake `/.git/config` + `/.env`; no contract change; **every tool image must be rebuilt** (shared lib changed) | ✅ done (branch `phase-6c6`, awaiting my check) |
| 6C-7 | wafw00f in `http` (active, url; pip `--require-hashes` venv; 2–7 GETs with attack-looking test strings, no redirects; named WAF → technology, generic → `generic-waf`, none → success) and new group `tls` with testssl.sh 3.2.5 (active, https url or tcp port; `-p -s -S -U`, `--ip one`, `--nodns min`, no `--phone-out`/curl; ip → port → certificate, port serves url, every LOW+ result → vulnerability; no TLS/closed/unresolvable → failed with the reason); lab fake WAF on `/waf/`; no contract change; **rebuild `http` and `tls`** | ✅ done (branch `phase-6c7`, awaiting my check) |

## How I work with Claude Code

- **Plan first**: Claude Code proposes a plan, I review it (design questions go to a chat like this one), then it codes.
- Each phase on its **own branch**; after every green step (`pnpm typecheck` + `pnpm test`) a **checkpoint commit**
  ("<phase> step N: …") and a push to GitHub.
- A `docs/<phase>-progress.md` file (steps, decisions, exact next action) is committed with each step, so a session
  that gets cut off can continue from it without asking.
- **Merge to main only after my manual check.** I do the merge.
- Until real engagement data exists, schema changes get **no backfill**: the server refuses an old-schema DB; delete
  `data/redwhale.db` and run `pnpm mock`.

## Next up

1. Tool batches, in order: ~~dnsx → naabu~~ (6C-3) → ~~nmap~~ (6C-4) → ~~katana + gau~~ (6C-5) → ~~nuclei~~ (6C-6) → ~~wafw00f + testssl~~ (6C-7) → the rest (active ones
   use `contacts`, the confirmation and the lab; scripts that name the target as a parent use `{targetType}`).
2. Redirect following stays out until 6D (httpx keeps the `Location` as data).
3. **6D** presets + auto-chaining (redirect-following tools re-check scope on every hop) → **6E** scan diffing →
   **6F** reports.

## Key decisions (short; full list in architecture.md §13)

- **Graph (5B–5D):** filter counts are workspace totals; search shows matches plus their ancestor path; Tree = ELK
  layered (keeps sibling order, positions never saved). Group = 2+ siblings with the same parent, relation and type,
  collapsed by default; the group's fill is its riskiest member, badge counts high/critical below. Search/table/
  highlights open exactly the path to a node. The server draws the whole view; the browser only keeps open groups.
- **Mocks:** `pnpm mock` = showcase (`showcase.example`, ~80 nodes), `pnpm mock:large` = big graph; both wipe the DB,
  seed a scope, and refuse a DB holding a real scan unless `--force`.
- **Scope (6A):** default deny, exclude wins, `*.example.com` ≠ `example.com`; a domain never puts its IPs in scope;
  passive-only on by default; broad includes refused (CIDR wider than /8 or /32, wildcards on a public suffix).
- **Edges (6B):** edge confidence = distinct tools over edge observations, never `verified`. Known limit: the `tool`
  filter selects nodes, so it can keep an edge that tool never reported.
- **Runner (6C-1):** one container per job, one image per group (tagged by a hash of its files); `authorize()` at
  queueing and right before start; scope changes cancel queued jobs; refused runs are kept as `refused` jobs.
  Fixtures are real outputs from an authorized target, anonymized to `northwind.example` (target never named in the repo).
- **Editing:** delete is allowed but only by the analyst (CLAUDE.md rule 4 amended), no undo; subtree delete keeps
  shared nodes that something else still reaches; group delete = members the current filters keep; refused while a job
  runs on a node ("Cancel job and delete"). Hand-added nodes go through ingest as tool `manual` and never corroborate.
- **Active tools (6C-2):** jobs run on the `redwhale-tools` network (not internal; `172.29.250.0/24`,
  `REDWHALE_NET_SUBNET`); the lab `lab.redwhale.test` (`172.29.250.10`, no host ports) is the only place to try active
  tools, and `lab:up` never touches the scope. Active runs need `confirmActive` (428 otherwise, before `authorize()`);
  the UI asks every time. Tool definitions: `{targetType}` (the server passes the node type; scripts never guess it)
  and `contacts` (required for active tools). httpx never follows redirects; technologies via `tech_value()`.
- **DNS and ports (6C-3):** tools that resolve names use only `/etc/resolv.conf`'s servers (`resolver_args()`) and
  refuse to run without one (`needs_resolvers=True`; replays skip it). dnsx never reports its target (resolving the
  name you were given isn't discovery): `ip` + `resolves_to`, the CNAME in the ip's data; dangling CNAMEs are a later
  improvement. naabu takes one IP only, connect scan, no host discovery, container hardening unchanged.
- **nmap (6C-4):** mode from `{targetType}` (builders get `command(target, target_type)` when
  `needs_target_type=True`); connect scan + `-sV` as user 10001 with no capability; `-sV` runs nmap's 47 `version`
  scripts and `contacts` says so; never `-sC`/`--script`/`-O`/`-A`/`-sU`. Installed from Debian, exact version
  pinned (the one exception to checksummed releases; bump `NMAP_VERSION` when Debian replaces it). nmap's and
  httpx's `nginx/1.30.6` are one node (corroborated).

- **Takeover check (TW-1):** a CNAME's target is a `domain` if it is the registrable name (PSL ICANN section), else
  a `subdomain` under its domain; external domains have no parent. RDAP 404 is the only "not registered" (WHOIS gives
  a date or unknown); RDAP redirects are never followed; private-suffix names (`x.herokuapp.com`) get `service`, not a
  lookup. An NXDOMAIN hop inside the target's own domain is not dangling (only the zone owner can create it; its
  rcode stays in data). The target's own registrable domain is a finding (exception to the 6C-3 rule). Raw output = a transcript
  of every exchange; `parse()` always replays it through the same logic. PSL/bootstrap are bundled, downloaded only
  by `pnpm tools:refresh-data`. Migrations now run with foreign keys off, then `foreign_key_check`.
- **Takeover watch (TW-2):** no stored table; each row comes from the subdomain's latest takeover-check scan only.
  Status order takeable → expiring (< 90 days, expired first) → unknown → ok → not checked → out of scope; the row
  shows the weakest link among all domains looked up (own domain included). A checked subdomain that left the scope
  keeps its status ("not refreshed"). Auto checks: in-scope subdomains not checked in 24 h, at most
  `REDWHALE_AUTO_MAX_QUEUED` (10) queued, manual jobs first, failed ones retried after 24 h, each through
  `authorize()`; "Auto takeover checks" switch (default on; off cancels queued auto jobs). Third-party chain names
  (out of scope, only takeover-check saw them) are hidden from the graph, table and watch unless the sidebar's
  "show external CNAME names" is on; nothing is deleted. Within a status, least time left first.
- **URL discovery (6C-5):** no contract change (`serves` domain/subdomain → url, `has_url` url → url exist). gau runs
  once per provider (its JSON names none), exits 0 even when one fails (only a `--verbose` warning says so): the
  failed provider is named, status partial, the others' URLs kept; 5,000 at most. katana: `-fs fqdn -dr -d 2 -jc`,
  **no `-kf`** (v1.8.0's sitemap handling loses the pages it lists), `-ndef` (its own denylist drops PDFs),
  `-eof body` (not `-ob`, which turns off JS parsing); its duplicate-content filter stays on. One static-extension
  list (images, fonts, media) for both; CSS/JS/PDF kept.
- **Vulnerability scanning (6C-6):** nuclei v3.11.1 + templates v10.5.1 (sha256-pinned, ≥ 2 weeks old, read-only in the image with a read-only config folder; never updates or downloads). HTTP templates only; `ssrf,oast,proxy` excluded too (templates that make the target fetch a hard-coded outside host, which `-ni` misses). 3600 s job, nuclei's own `-mt 55m`; a skipped host or the time limit → `partial` (read from stderr, so no `-silent`). One finding per value + URL (`data.matcher` a list); extracted values masked, raw.txt unredacted (evidence, local). Path-traversal matches hang off the target (the server would resolve `..` into a misleading URL). `--template-ids` is test-only and can only narrow. Fast e2e every run; full scan with `REDWHALE_E2E_SLOW=1`.
- **WAF and TLS (6C-7):** wafw00f 2.4.2 and its dependencies pinned by version + wheel sha256 (`--require-hashes`, wheels only). wafw00f requests only the URL as given (plus query strings); first signature wins (never `-a`). testssl.sh 3.2.5 (source archive sha256; its own OpenSSL); one address (`--ip one`, named in the data), DNS only A/AAAA via the system resolver. The certificate hangs off the **port** (contract: no url → certificate); port targets drop `cert_trust` (no hostname). The lab plays a WAF on `/waf/` only (Shadow Daemon's signature, lab-named page). Fast e2e every run; full testssl with `REDWHALE_E2E_SLOW=1`.

## Open items

- **Manual check** for 6C-4 (`docs/phase-6c4-progress.md`), then merge `phase-6c4`; then TW-1's
  (`docs/phase-tw1-progress.md`), then merge `phase-tw1`; then TW-2's (`docs/phase-tw2-progress.md`), then merge
  `phase-tw2`; then 6C-5's (`docs/phase-6c5-progress.md`), then merge `phase-6c5`; then 6C-6's
  (`docs/phase-6c6-progress.md`), then merge `phase-6c6`; then 6C-7's (`docs/phase-6c7-progress.md`), then merge
  `phase-6c7`. After merging: `pnpm tools:build` (all groups; 6C-6 changed the shared lib, 6C-7 adds `tls`) and `pnpm lab:up` (`/waf/`).
- **Intrusive-tools question (open):** nuclei's `cve` set still holds state-changing checks not tagged `intrusive` (e.g. CVE-2022-1388's `POST /mgmt/tm/util/bash`; `rce`, `file-upload` tags).
- **Takeover, later:** HTTP fingerprints of cloud services ("NoSuchBucket", "No such app"), TLS certificate expiry
  (testssl's certificate nodes now carry `not_after`; certificate SANs as subdomain findings are also later).
  An in-scope domain with no checked subdomain never shows its own expiry (takeover-check takes subdomains only):
  maybe domain rows later.
- **Teammates' real scripts** not yet tested end to end (`pnpm tools:check` → run in the group → check the graph).
- **Technology spelling:** `tech_value()` fixes case/spaces, but different tools still name things differently
  (`iis` vs `microsoft-iis`), so corroboration can silently fail: maybe an alias table later.
- **Intrusive tools** (sqlmap, SSRFmap, dalfox) vs the "no destructive payloads" promise in features.md: undecided.
- **Local authentication for the UI** is promised but not built.
- **DEPI demo plan:** live `pnpm ingest` (map grows), a group run showing corroboration, the scope guard refusing a
  target. Take screenshots of each milestone for slides.
- Smaller: Tree layout near the 2,000 cap takes ~4.4 s (acceptable?); re-check canvas feel in Firefox with
  `await redwhale.bench()`; `pnpm tools:build` leaves old image tags behind (`docker image prune`).
