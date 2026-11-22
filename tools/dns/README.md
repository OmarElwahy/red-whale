# Tool group: DNS (`dns`)

Image `redwhale-tools/dns:<hash>` (`pnpm tools:build dns`). **Passive**: these tools ask the system DNS resolver
(in a job container, Docker's `127.0.0.11`, which forwards to your machine's DNS) and, for takeover-check, RDAP and
WHOIS servers about registrations; never the target itself. No confirmation dialog; the target must still be in scope.

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `dnsx` | v1.3.1 (2026-08-31) | passive | domain, subdomain | none | system DNS resolver |
| `takeover-check` | dnsx v1.3.1 + whois 5.6.3 (Debian) | passive | subdomain | none | system DNS resolver, RDAP servers (IANA bootstrap), WHOIS servers (fallback) |

Bundled data (`data/`, see `data/README.md`): the Public Suffix List and IANA's RDAP bootstrap, refreshed only by
`pnpm tools:refresh-data` (a refresh changes the image tag).

## dnsx

Command (flags checked against `dnsx -h` of v1.3.1), as `run.py` builds it:

```
/usr/local/bin/dnsx -l <target> -a -aaaa -cname -j -silent -nc -duc -rl 10 -t 5 -retry 2 -r <the machine's own resolvers>
```

- `-l <target>`: exactly the one name it was run on. **Never brute-forces** (no `-d`, no `-w`, ever). `-l` would also
  read a file or a comma list, so `run.py` refuses a target that is an existing path or holds a comma.
- `-a -aaaa -cname`: those record types only.
- `-r`: DNS only through the machine's resolver, from `/etc/resolv.conf` (`resolver_args()` in the helper). Without
  it dnsx asks its built-in public resolvers. With no nameserver in that file the run is **refused** before dnsx
  starts: status `failed`, "no system resolver found; refusing to use public ones" (`main(..., needs_resolvers=True)`;
  a `--replay` skips the check).
- `-duc`: no update check (no call to ProjectDiscovery).

Findings: one `ip` per A/AAAA answer, target →`resolves_to` ip. The target itself is **never** a finding: resolving
the name you were given isn't discovering it (httpx doesn't report its target either). A CNAME goes in each ip's
data (`cname`: a string, or the chain as a list in dnsx's order). A CNAME with no A/AAAA answer (dangling) gives no
finding: it is noted in the job's log and is in `raw.txt` (dangling-CNAME detection is a later improvement). The
script needs the target's node type (`--target-type`, `{targetType}` in `tool.json`).

Fixture: real output captured from the lab, anonymized, plus edited AAAA/CNAME lines (`dnsx/fixtures/NOTE.md`);
`pnpm tools:check dnsx`.

## takeover-check

Follows the target's CNAME chain, finds each name's registrable domain (PSL, ICANN section) and looks up its
registration, then reports takeover risks. Full description: `docs/architecture.md` §11; decisions in §13.

DNS, one name at a time (flags checked against `dnsx -h` of v1.3.1; dnsx prints no rcode together with `-cname`):

```
/usr/local/bin/dnsx -l <name> -cname -j -silent -nc -duc -or -retry 2 -timeout 5s -t 1 -rl 10 -r <own resolvers>
/usr/local/bin/dnsx -l <name> -rcode noerror,nxdomain,servfail,refused -j -silent -nc -duc -or -retry 2 -timeout 5s -t 1 -rl 10 -r <own resolvers>
```

The second only when the first printed nothing (the end of the chain). At most 10 hops; a loop stops the chain.
Without a system resolver the run is refused, like dnsx.

Registrations: RDAP `GET <server>/domain/<domain>` (server from `data/dns.json`; redirects are not followed), or
`/usr/bin/whois <domain>` for a TLD with no RDAP service. Each domain once per run, ≥ 1 s between requests to one
server, 2 retries with backoff. RDAP 404 is the only "not registered"; WHOIS gives a parsed expiry date or unknown.

Findings: each hop (`subdomain`/`domain`) with `cname_to`, data `rcode` (and `service` under a PSL private suffix such
as `herokuapp.com`, `loops_to` on a loop); each looked-up `domain` with `registered`, `expires_at`, `registrar`,
`created_at`, `source`, `checked_at` (`reason` when unknown or 404); on the target, `takeover-unregistered-domain`
(critical) and `takeover-dangling-cname` (medium). The target is never a finding; its own registrable domain is.

`raw.txt` is a **transcript** of every exchange; `--replay` re-runs the same logic on it with no network. Fixtures: 8
cases, real exchanges, some assembled (`takeover-check/fixtures/NOTE.md`); `pnpm tools:check takeover-check`.
