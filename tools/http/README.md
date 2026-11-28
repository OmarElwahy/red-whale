# Tool group: HTTP probing (`http`)

Image `redwhale-tools/http:<hash>` (`pnpm tools:build http`). **Active**: these tools talk to the target itself, so
the server asks for `confirmActive` (the UI's "Run active scan" dialog), passive-only must be off, and the target
must be in scope.

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `httpx` | v1.12.0 (2026-09-08) | active | domain, subdomain | HTTP(S) to the target on 80 and 443, ≤ 5 requests/s | none |
| `wafw00f` | 2.4.2 (2026-01-26) | active | url | 2–7 GETs to the URL, some with attack-looking test strings | none |

## httpx

Command (flags checked against `httpx -h` of v1.12.0), as `run.py` builds it:

```
/usr/local/bin/httpx -u <target> -p http:80,https:443 -nf -j -silent -nc -no-stdin -duc -sc -title -server -td -ip -location -rl 5 -t 5 -timeout 10 -retries 1 -r <the machine's own resolvers>
```

- Probes exactly `http://<target>:80` and `https://<target>:443` (`-nf`: both, not only the first that answers).
- **Never follows redirects** (no `-fr`): a `301` is reported with its `Location` in the url's data, and the other
  host is not contacted or reported (following redirects is phase 6D).
- `-r`: DNS only through the machine's resolver (in a job container, Docker's `127.0.0.11`). Without it httpx also
  asks public resolvers (8.8.8.8, 1.1.1.1…), which would learn the target's name. With no nameserver in
  `/etc/resolv.conf` the run is refused before httpx starts ("no system resolver found; refusing to use public
  ones"; since 6C-3, shared with dnsx in the helper).
- `-duc`: no update check (no call to ProjectDiscovery).

Findings, per answering port: target →`resolves_to` ip →`has_port` `ip:port/tcp` →`serves` url →`uses_technology`
technology. The url's data: `status_code`, `title`, `webserver`, `location`. Technologies are spelled by
`tech_value()` (`Nginx:1.30.6` → `nginx/1.30.6`). The script needs the target's node type (`--target-type`,
`{targetType}` in `tool.json`): the parent of the ip is the node you ran it on, never a guess.

Try it safely against the local lab: `lab/README.md`.

Fixture: real output captured from the lab, anonymized (`httpx/fixtures/NOTE.md`); `pnpm tools:check httpx`.

## wafw00f

Installed from PyPI with `pip --require-hashes --no-deps --only-binary :all:` from `wafw00f/requirements.txt`, which
pins wafw00f and every dependency (requests, urllib3, idna, charset-normalizer, certifi, PySocks) to an exact
version and each wheel's sha256: nothing is resolved or built at build time. It lives in its own venv
`/opt/wafw00f` (pip removed from it). Command (flags checked against `wafw00f -h` of 2.4.2), as `run.py` builds it:

```
/opt/wafw00f/bin/wafw00f -r -o - -f json --no-colors -T 10 <url>
```

- `-r`: **never follows a redirect**. `-o - -f json`: the result as JSON on stdout (wafw00f's log goes to stderr).
  Never `-a` (test every signature), `-p` (proxy), `-i`, `-H`, `-t`, `-v`.
- **What it sends** (read in wafw00f's source, seen in the lab's log): every request goes to the URL exactly as given
  (wafw00f only adds query strings, never another path or host). A normal GET; then one GET whose query string
  carries three **attack-looking test strings** (`<script>alert("XSS");</script>`, `UNION SELECT ALL FROM
  information_schema AND " or SLEEP(5) or "`, `../../etc/passwd`), whose answer is matched against wafw00f's ~170
  signatures. Stops at the first match (**2 requests**). With no match, "generic" detection: a normal GET, one with
  requests' own User-Agent (`python-requests/…`), then the XSS string, a plain GET and the SQL string alone,
  comparing status codes and the `Server` header with the normal answer (**7 requests** at most). Nothing is
  exploited: the strings only make a WAF show itself. Some targets log or alert on them, though.
- Findings: url →`uses_technology` technology, named by `tech_value()` (`Shadow Daemon` → `shadow-daemon`,
  `Cloudflare` → `cloudflare`, merging with httpx's and nuclei's), data `{waf: true, manufacturer}`. **Generic
  detection** (something answered the attacks differently, no signature named it): `generic-waf`, data
  `{waf: true, manufacturer: null, generic: true}`; weak evidence, shown so the analyst can look. **No WAF**:
  success, no findings. No answer to the normal request ("appears to be down"): failed, with wafw00f's reason.
- Try it against the lab (`lab/README.md`): `https://lab.redwhale.test/waf/` plays a WAF (wafw00f names it Shadow
  Daemon: the lab's 403 page matches that signature, but nothing of that product is in the lab);
  `https://lab.redwhale.test/` has none.

Fixtures: real lab captures (`wafw00f/fixtures/NOTE.md`); `pnpm tools:check wafw00f`.

**Updating wafw00f:** pick the newest release (and dependency releases) at least two weeks old, resolve them in the
image's Python (`docker run --rm <python image> pip download "wafw00f==<v>" --only-binary :all: -d /w`, then
`sha256sum /w/*`), write every version and hash into `requirements.txt`, rebuild (`pnpm tools:build http`), re-capture
the fixtures.
