# Tool group: port scanning (`ports`: naabu, nmap)

Image `redwhale-tools/ports:<hash>` (`pnpm tools:build ports`). **Active**: these tools connect to the target itself,
so the server asks for `confirmActive` (the UI's "Run active scan" dialog), passive-only must be off, and the target
must be in scope (an IP: only `ip`/`cidr` rules match it; a domain in scope never puts its IPs in scope).

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `naabu` | v2.7.0 (2026-10-28) | active | ip | TCP connections to the top 100 ports, ≤ 50/s | none |
| `nmap` | 7.95 (Debian `7.95+dfsg-3`) | active | ip, port | TCP connections to the top 100 ports (or the one port), ≤ 50/s, plus service-detection probes and nmap's version-detection scripts | none |

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

Try it safely against the local lab (`lab/README.md`): the lab listens on 22, 80, 443 and 8080.

Fixture: real output captured from the lab, anonymized (`naabu/fixtures/NOTE.md`); `pnpm tools:check naabu`.

## nmap

Installed from the base image's Debian (trixie) repository, pinned to `nmap=7.95+dfsg-3` (`NMAP_VERSION` in the
`Dockerfile`): the one tool here that isn't a sha256-checked release download. nmap ships no checksummed Linux binary,
and apt checks Debian's signatures. If `pnpm tools:build ports` fails with "the pinned nmap version may have left
Debian's repository", Debian replaced that version: bump `NMAP_VERSION` to what `apt-cache policy nmap` shows in the
base image (`docs/architecture.md` §13).

The mode comes from the target node's **type** (`{targetType}`, passed by the server), never from the value's shape.
A value that doesn't fit its type (or a `/udp` port) is refused before nmap starts. Command (flags checked against
`nmap --help` of 7.95), as `run.py` builds it:

```
/usr/bin/nmap -sT -Pn -n [-6] -sV --unprivileged --noninteractive --max-rate 50 --max-retries 1 --host-timeout 480s (--top-ports 100 | -p <port>) -oX - <ip>
```

- `-sT --unprivileged`: **connect scan**, and nmap assumes it has no raw sockets. It runs as user 10001 with
  `cap-drop ALL`: no `NET_RAW`, no `NET_ADMIN`, no file capability on the binary.
- `-Pn -n`: no host discovery, no DNS (forward or reverse). `-6` only for an IPv6 target.
- `-sV`: service/version detection at the default intensity. **It also runs nmap's "version" category scripts**
  (47 in 7.95; against a web server, e.g. `http-server-header`, `hnap-info`, `vmware-version`, `http-trane-info`,
  `https-redirect`, which request paths like `/HNAP1`, `/evox/about`, `POST /sdk`). That is part of what `-sV`
  means; `contacts` says so. No other scripts: `-sC`, `--script`, `-O`, `-A` and `-sU` never appear (a test checks
  every mode).
- `--max-rate 50 --max-retries 1 --host-timeout 480s`: at most 50 probes a second; a filtered port gets one retry;
  nmap gives up on the host before the job's 600 s timeout (the script gets 570 s) and still writes its XML.
- `--top-ports 100` for an `ip`; `-p <port>` for a `port` (`ip:port/tcp`, IPv6 as `[ip]:port/tcp`).
- `-oX -`: XML to stdout, no other output file. Parsed with `xml.etree`, never regular expressions.

Findings: every **open** port is a `port` (ip →`has_port` `ip:port/tcp`, spelled by `port_value()`) with
`data.protocol`, `service` (only when nmap probed it, not a guess from the port number), `product`, `version`,
`extrainfo`, `tunnel` when present. A known product is a `technology` (`tech_value(product, version)`, e.g.
`nginx/1.30.6`, `openssh/9.6p1`), port →`uses_technology`. Closed and filtered ports are not findings: a closed port
target is a success with no findings (nmap's answer stays in `raw.txt`). Errors: unreadable XML, nmap's own error,
the host timeout, a host other than the target.

Try it against the local lab: it answers on 22 (a fake SSH banner), 80, 443 and 8080. `nginx/1.30.6` from nmap and
from httpx is one node, so it becomes `corroborated`.

Fixtures: real output from the lab in ip and port mode, anonymized (`nmap/fixtures/NOTE.md`); `pnpm tools:check nmap`.
