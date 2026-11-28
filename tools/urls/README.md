# Tool group: URL discovery (`urls`)

Image `redwhale-tools/urls:<hash>` (`pnpm tools:build urls`). Two tools that find URLs in different ways, so a URL
both find becomes **corroborated**: gau asks web archives which URLs they have seen on a host (passive), katana
crawls a URL's host (active: the server asks for `confirmActive`, passive-only must be off, and the target must be
in scope).

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `gau` | v2.2.4 (2024-10-28) | passive | domain, subdomain | none (the target is never contacted) | Wayback Machine, Common Crawl, AlienVault OTX |
| `katana` | v1.8.0 (2026-10-05) | active | url | pages, scripts and other files linked from the URL, on its host only; GET, two levels deep, ≤ 5 requests/s, no redirects | none |

Both binaries are checksummed release archives (`Dockerfile`). Images, fonts, audio and video are never reported or
requested: one list, `urls_common.py` `STATIC_EXTENSIONS`, used by gau's `--blacklist` and katana's `-ef`. CSS,
JavaScript and PDF are kept (they can name endpoints). `urls_common.canonical_url()` spells a URL as the server stores
it (lowercase scheme and host, no default port, `/` at least, no fragment).

## gau

Command (flags checked against `gau --help` of v2.2.4), **once per provider, one after another**:

```
/usr/local/bin/gau --providers <wayback|commoncrawl|otx> --threads 2 --blacklist <STATIC_EXTENSIONS> --json --verbose --timeout <≤ 180> --retries 1 <target>
```

- **One provider per run** because gau's JSON lines are only `{"url": …}`: running them separately is the only way
  to say which archive had a URL. Each run gets the time left divided by the providers left (`timeoutSec` 900; the
  script gets 870), so a fast provider's leftover goes to the next.
- **The target host only**: no `--subs`. OTX answers with other hosts anyway (`www.`, `api.` of the target); those
  are ignored, like archived strings that aren't usable URLs (a bad port, not http(s)). A space in a path is kept
  (the server encodes it).
- **Failures**: gau exits 0 when a provider fails and says so only in a `level=warning` line with `--verbose`
  (`failed to fetch wayback results page 0: timeout`, `API responded with non-200 status code`). A provider that
  times out, exits non-zero or logs a warning/error is named in an error (`wayback failed: …`, status `partial`);
  the other providers' URLs are kept. The `error reading config` warning is expected (no config file: no API keys).
- **Cap**: 5,000 URLs after deduplication, the first in provider order; more is an error (`partial`).
- No API keys: urlscan (needs one) is not used.

Findings: target →`serves` url, data `{"source": [providers, sorted], "historical": true}` (an archive saw it once;
it may be gone). The script needs the target's node type (`--target-type`, `{targetType}`).

Raw output (`raw.txt`) is one section per provider, gau's lines unchanged: `#provider <name> exit=<code|timeout|error>`,
its stdout, `#stderr <name>`, its stderr.

Fixture: a real capture against an authorized target, anonymized, + 4 edited lines (`gau/fixtures/NOTE.md`); the
5,000 cap is tested on a synthetic file in `gau/test_gau.py`. That day wayback timed out on its first page and
commoncrawl answered for the domain but not for its `www.` host: archive outages are normal, which is why one
failed provider doesn't fail the run.

## katana

Command (flags checked against `katana -h` of v1.8.0), as `run.py` builds it:

```
/usr/local/bin/katana -u <url> -fs fqdn -dr -d 2 -jc -ndef -ef <STATIC_EXTENSIONS> -rl 5 -c 2 -p 1 -ct 210s -timeout 10 -retry 1 -j -or -eof body -silent -nc -duc -r <the machine's own resolvers>
```

- `-fs fqdn`: the URL's exact host only (any scheme or port on it). `-dr`: **never follows a redirect**; a 3xx is
  reported with its `Location` in data and the other host is not contacted (following redirects is phase 6D).
- `-d 2 -jc`: two levels deep, and endpoints named in JavaScript files. katana's own HTML regex sometimes reaches a
  page one level further; a URL found beyond the depth is reported without a status (`error: "max depth reached"`).
- `-ndef -ef`: katana's built-in extension denylist is off (it drops PDFs); ours is the only filter, and filtered
  URLs are not requested at all.
- **No `-kf`** (known files): in v1.8.0, `-kf sitemapxml` loses every URL the sitemap lists and every page reached
  only through them (checked in the lab at depth 2, 3 and 5), and `-kf robotstxt` fetches robots.txt without
  requesting or reporting its entries. Worth re-checking on a later katana (the lab keeps both files).
- `-eof body`, not `-ob`: `-ob` also turns off the JavaScript parsing. `-or`: no raw requests/responses.
- `-ct 210s`: the crawl ends itself inside `timeoutSec` 300 (the script gets 270).
- `-r`: DNS only through the machine's resolver; with none, the run is refused (`needs_resolvers=True`).
- Never: headless (`-hl`), form filling (`-aff`), custom headers, any non-GET request.
- katana prints nothing for a page whose body equals one it already printed (its duplicate-content filter; in the
  lab, `/item.html?id=1` after `/item.html`). Left on.

Findings: the target URL itself (no parent: katana fetched it), then every URL →`has_url` from the page it was found
on (katana's `source`; the target if there is none). data: `status_code`, `location` (3xx), `tag`/`attribute`
(`a`/`href`, `script`/`src`, `js`/`regex`…), `error`. A URL on another host is ignored (a second check after
`-fs fqdn`).

Try it safely against the local lab's crawl site (`lab/README.md`): add the scope rules `lab:up` prints, turn
passive-only off, add a url node `https://lab.redwhale.test/` (or run httpx on `lab.redwhale.test` first), then Run
tool ▸ katana. Fixture: a real capture against the lab, anonymized, + 1 edited line (`katana/fixtures/NOTE.md`);
`server/test/katana.e2e.test.ts` checks the lab's access log.
