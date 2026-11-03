# Tool group: HTTP probing (`http`)

Image `redwhale-tools/http:<hash>` (`pnpm tools:build http`). **Active**: these tools talk to the target itself, so
the server asks for `confirmActive` (the UI's "Run active scan" dialog), passive-only must be off, and the target
must be in scope.

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `httpx` | v1.12.0 (2026-09-08) | active | domain, subdomain | HTTP(S) to the target on 80 and 443, ≤ 5 requests/s | none |

## httpx

Command (flags checked against `httpx -h` of v1.12.0), as `run.py` builds it:

```
/usr/local/bin/httpx -u <target> -p http:80,https:443 -nf -j -silent -nc -no-stdin -duc -sc -title -server -td -ip -location -rl 5 -t 5 -timeout 10 -retries 1 -r <the machine's own resolvers>
```

- Probes exactly `http://<target>:80` and `https://<target>:443` (`-nf`: both, not only the first that answers).
- **Never follows redirects** (no `-fr`): a `301` is reported with its `Location` in the url's data, and the other
  host is not contacted or reported (following redirects is phase 6D).
- `-r`: DNS only through the machine's resolver (in a job container, Docker's `127.0.0.11`). Without it httpx also
  asks public resolvers (8.8.8.8, 1.1.1.1…), which would learn the target's name.
- `-duc`: no update check (no call to ProjectDiscovery).

Findings, per answering port: target →`resolves_to` ip →`has_port` `ip:port/tcp` →`serves` url →`uses_technology`
technology. The url's data: `status_code`, `title`, `webserver`, `location`. Technologies are spelled by
`tech_value()` (`Nginx:1.30.6` → `nginx/1.30.6`). The script needs the target's node type (`--target-type`,
`{targetType}` in `tool.json`): the parent of the ip is the node you ran it on, never a guess.

Try it safely against the local lab: `lab/README.md`.

Fixture: real output captured from the lab, anonymized (`httpx/fixtures/NOTE.md`); `pnpm tools:check httpx`.
