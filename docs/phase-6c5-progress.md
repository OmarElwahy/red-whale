# Phase 6C-5 progress: URL discovery (gau + katana)

Branch `phase-6c5`, cut from `phase-tw2` (`e808f04`). Started 2026-11-24.

**Goal:** a new tool group `urls` ("URL discovery"): gau (passive, historical URLs) and katana (active crawler), so
a URL both tools find becomes corroborated.

**Not in scope:** nuclei; headless crawling (`-hl`); form filling (`-aff`) or any non-GET request; following
redirects or chaining (6D); feeding found URLs into other tools; provider API keys (urlscan).

## Steps

| # | Step | Status |
|---|---|---|
| 1+2 | Contract check (no change needed) + `urls` group: Dockerfile, gau (tool.json, run.py, fixture, tests) | done |
| 3 | Lab crawl site + katana (tool.json, run.py, lab fixture, tests, e2e) | done |
| 4 | Docs (architecture §11/§13, tools/urls/README, team-guide row, handoff) + manual checklist | |

## Decisions

- **No contract change.** contract.md §4 already has `serves`: `port` / `subdomain` / `domain` → `url` (gau: the
  target → a historical URL) and `has_url`: `url` → `url` (katana: the page a link was found on → the link). No
  migration.
- **gau** v2.2.4 (2024-10-28), **katana** v1.8.0 (2026-10-05): checksummed release archives, both over 2 weeks old.
- **gau runs once per provider** (wayback, commoncrawl, otx), one after another: its `--json` lines are only
  `{"url": …}`, with no provider. Each run gets the time left divided by the providers left (a fast provider's
  leftover goes to the next). `data = {"source": [sorted providers], "historical": true}`.
- **gau failures are only warnings**: gau exits 0 when a provider fails and logs it only with `--verbose`
  (`level=warning msg="… failed to fetch wayback results page 0: timeout"`, `"API responded with non-200 status
  code"`). run.py runs with `--verbose`; a provider that times out, exits non-zero or logs a warning/error (except
  "error reading config": no config file is expected) is named in an error (partial); the others' URLs are kept.
- **gau raw output** is sectioned, gau's own lines unchanged: `#provider <p> exit=<code|timeout|error>`, its stdout,
  `#stderr <p>`, its stderr.
- **Target host only**: OTX answers with other hosts even without `--subs` (`rdap.<target>`, `www.<target>`); those
  and unusable archive strings count as ignored, not errors (a space in the path is kept: the server encodes it).
- **Cap**: 5,000 URLs after deduplication (as the server spells them: no default port, no fragment, `/` at least),
  the first ones in provider order; more is an error (partial).
- **Static blacklist**: one constant, `tools/urls/urls_common.py` `STATIC_EXTENSIONS` (images, fonts, audio, video),
  used by gau `--blacklist` and katana `-ef`. CSS, JS and PDF stay.
- **katana: no `-kf`** (user, 2026-11-24). In v1.8.0 `-kf sitemapxml` loses every URL the sitemap lists and every page
  reached only through them (lab: products/item/deep/contact never fetched; at depth 2, 3 and 5, and with `-duf`);
  `-kf robotstxt` fetches robots.txt but never requests or outputs its entries. The lab keeps robots.txt and
  sitemap.xml so this can be re-checked on a later katana.
- **katana `-ndef`**: katana has its own default extension denylist (it skipped the lab's PDF:
  "filtered path. skipping"); `-ndef` removes it, so `-ef <STATIC_ARG>` is the only filter.
- **katana `-eof body`, not `-ob`**: `-ob` also turns off JavaScript parsing (the lab's `/api/v1/orders`, named only
  in `app.js`, was never found with `-ob`, always without it). `-eof body` keeps the body out of the JSON and the
  parsing on. `-or` (no raw request/response) is fine.
- **katana depth**: `-d 2` in practice reaches the lab's `deep.html` (3 links from home) through katana's own HTML
  regex extraction; output order varies between runs. The e2e asserts a stable subset, not exact lists.
- **Lab**: the site moved to `lab/site/` (`index.html` keeps its title and text, plus links); `LAB_FILES` lists every
  file. nginx now sends content types (it had none: everything was `text/html`) and `/api/v1/orders` (JSON 200).

## Probe results (katana v1.8.0 against the lab, 2026-11-23)

Final candidate argv:
`katana -u <url> -fs fqdn -dr -d 2 -jc -ndef -ef <STATIC_ARG> -rl 5 -c 2 -p 1 -ct <s> -timeout 10 -retry 1 -j -or
-eof body -silent -nc -duc -r <resolvers>`. Found: `/`, `site.css`, `app.js`, `http://lab…/` (301, not followed),
`about.html`, `products.html`, `item.html`, `/api/v1/orders` (source `app.js`, tag `js`/`regex`), `brochure.pdf`,
`deep.html`. Never requested (access log): `elsewhere.redwhale.test`, `logo.png`. JSON line:
`{"timestamp", "request": {"method", "endpoint", "tag", "attribute", "source"}, "response": {"status_code",
"headers", "content_length"}}`; an endpoint found but not fetched has no `status_code`.

## Notes from step 1+2

- gau capture probes (raw in the scratchpad only, target in local memory): otx answered (2 lines, both other hosts);
  wayback timed out on page 0 (90 s and 180 s per-request timeouts), though the CDX API answers curl in 20–30 s;
  commoncrawl's index answered 504. All three exited 0.
- Python tests: `tools/urls/test_urls_common.py` (3), `tools/urls/gau/test_gau.py` (16: command, merge, host filter,
  failures, the 5,000 cap through `main --replay` on a synthetic file, fetch with a stand-in gau and a timeout).
- **Fixture** (`tools/urls/gau/fixtures/`): the real capture of 2026-11-24 against the domain (in local memory
  only), anonymized to `northwind.example` with the paths reworded (they named the target's customers); 29 lines,
  none trimmed, + 4 edited otx lines (a URL commoncrawl also had, a fragment, a default port, an unusable port).
  Result: 8 URLs, `partial` ("wayback failed: … page 0: timeout"). Wayback timed out after 90 s on page 0 in every
  try that day (gau `--timeout 180` too); its `showNumPages` request is refused from this network. The `www.`
  capture gave 1 URL (otx) and is not used.
- **Docker incident**: drive C: had 0.1 GB free, so Docker Desktop's disk went read-only (I/O errors). After the
  user freed space, the `urls` image still had broken binaries (gau zeros, katana cut at 4 MiB): the fetch stage
  had been cached while the disk was full. Fixed by removing that cached stage (`docker rmi`) and rebuilding; the
  build log's sha256 lines and `gau --version` / `katana -version` confirm the binaries.
- Catalog listings updated for the new group (`runner-docker`, `api/jobs`, `tools-fixtures` tests).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green.

## Notes from step 3

- **katana** `tool.json`: active, accepts `url`, `timeoutSec` 300 (`-ct 210s`; a test keeps it a minute inside the
  script's 270 s). Contacts: "fetches pages, scripts and other files linked from {target}, on {target}'s host only
  (GET, two levels deep, at most 5 requests a second; redirects are not followed)": no robots/sitemap, since there
  is no `-kf`.
- **Parse**: the target itself (no `source`) is a finding without a parent (katana fetched it: its status); every
  other URL hangs off its `source` page with `has_url`, or off the target when the source is missing, on another
  host or the URL itself. data: `status_code`, `location` (3xx), `tag`/`attribute`, `error` (e.g. "max depth
  reached": found, not fetched, no status). Another host is ignored (second check after `-fs fqdn`).
- **Fixture**: a real capture against the lab (2026-11-24), 11 lines, anonymized like httpx's, + 1 edited line for
  another host. 10 findings, `success`. The lab's log for the run: 11 requests, all `host=lab.redwhale.test`.
- **katana's duplicate-content filter**: it requested `/item.html?id=1` but printed no line for it (the same body as
  `/item.html`, which its HTML regex found first). Left on (it trims tracking-parameter noise); `-duf` would turn it
  off if query-string variants should be kept.
- **e2e** `server/test/katana.e2e.test.ts`: seeds the url node and a stand-in gau sighting of `/about.html`, runs
  katana through the orchestrator (confirm required), and checks the `has_url` edges (home → about/products/
  app.js/site.css/`http://`, app.js → `/api/v1/orders`, about → PDF), that `/about.html` is `corroborated` (two
  tools) and `/products.html` `discovered`, the 301's data, and the lab's log: nothing for `elsewhere`, and from
  katana's container (its address is the one that fetched `app.js`; other e2e suites probe the lab at the same time)
  only `host=lab.redwhale.test`, GETs only, exactly one `GET /` 301, and no logo/robots/sitemap/contact.
- Lab: `app.js` assigns `globalThis.loadOrders` (lint). httpx, naabu and nmap e2e pass against the new lab (the
  `http`/`ports` images were rebuilt for the current hashes).
- `pnpm typecheck`, `pnpm lint`, `pnpm test` green (77 files; the 5 lab e2e suites ran).

## Next action

Step 4 (docs): architecture §11 (the `urls` group, gau and katana rows, the lab's crawl site) and §13 (decisions:
no contract change; gau per provider and its warning-only failures; katana without `-kf`, with `-ndef` and
`-eof body`), `tools/urls/README.md`, the team-guide row, `docs/handoff.md` (Status, decisions, "Last updated" from
Get-Date), and a manual checklist in this file. Commit `6c5 step 4`, push.
