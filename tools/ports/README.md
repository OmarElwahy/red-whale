# Tool group: port scanning (`ports`)

Image `redwhale-tools/ports:<hash>` (`pnpm tools:build ports`). **Active**: these tools connect to the target itself,
so the server asks for `confirmActive` (the UI's "Run active scan" dialog), passive-only must be off, and the target
must be in scope (an IP: only `ip`/`cidr` rules match it; a domain in scope never puts its IPs in scope).

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `naabu` | v2.7.0 (2026-10-28) | active | ip | TCP connections to the top 100 ports, ≤ 50/s | none |

## naabu

Command (flags checked against `naabu -h` of v2.7.0), as `run.py` builds it:

```
/usr/local/bin/naabu -host <ip> -s c -Pn -tp 100 -rate 50 -c 10 -timeout 2s -retries 1 -j -silent -nc -duc -no-stdin
```

- `-host <ip>`: exactly one IP. `run.py` refuses anything else (a hostname, a comma list, a range) before naabu
  starts, so naabu never resolves a name or scans a second host.
- `-s c`: **connect scan**: ordinary TCP connections, no raw packets. The container keeps the normal hardening
  (`cap-drop ALL`, user 10001): no `NET_RAW`, no `NET_ADMIN`. The release binary needs no libpcap for this.
- `-Pn`: no host discovery (ICMP pings would need raw sockets); the host is assumed up.
- `-tp 100 -rate 50 -c 10 -timeout 2s -retries 1`: the top 100 TCP ports (they include 80, 443, 8080), at most 50
  connections a second, 10 workers.
- `-duc`: no update check. No cloud upload (`-dashboard` is never passed), no passive lookups (`-passive`), no nmap.
  Checked: a run with no network at all (`--network none`) logs no failed outside call.

Findings: one `port` per open port, ip →`has_port` `ip:port/tcp` (spelled by `port_value()`), with `data.protocol`.
Ports that httpx also reports (80, 443) become `corroborated`.

Try it safely against the local lab (`lab/README.md`): the lab listens on 80, 443 and 8080.

Fixture: real output captured from the lab, anonymized (`naabu/fixtures/NOTE.md`); `pnpm tools:check naabu`.
