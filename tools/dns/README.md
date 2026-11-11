# Tool group: DNS resolution (`dns`)

Image `redwhale-tools/dns:<hash>` (`pnpm tools:build dns`). **Passive**: these tools ask only the system DNS resolver
(in a job container, Docker's `127.0.0.11`, which forwards to your machine's DNS), never the target itself. No
confirmation dialog; the target must still be in scope.

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `dnsx` | v1.3.1 (2026-08-31) | passive | domain, subdomain | none | system DNS resolver |

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
