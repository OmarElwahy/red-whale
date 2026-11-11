# Phase 6C-4 — nmap (active service/version detection): progress

Branch `phase-6c4`, cut from `main` (31be938; everything through 6C-3 is merged). **Don't merge into main**: the user
merges after a manual check. After every step: `pnpm typecheck` + `pnpm test` green → update this file → commit
"6C-4 step N: <what>" (with this file) → `git push` (first time `git push -u origin phase-6c4`).
If a session is cut off: read this file, check `git log`, continue at "Next action". Don't ask the user.

Spec: the user's 6C-4 request. Goal: the lab answers on TCP 22 with a fake SSH banner, nmap in the existing `ports`
group, a real-Docker e2e test and docs. **Not in scope:** NSE scripts (`-sC`/`--script`), UDP, OS detection, other
tools, presets/auto-chaining, schema changes. Commands in docs must work in PowerShell (no `&&`).

## Steps

1. ✅ Lab banner on TCP 22 + README/status.
2. ✅ nmap in the `ports` group (Dockerfile, tool.json with `contacts`, run.py, the library's type-aware command
   builder, fixtures for ip and port mode, unit tests, `tools:check`).
3. ⬜ Real-Docker e2e test; docs: architecture §11/§13, team-guide (nmap as the XML example, the apt-pin exception,
   the new builder signature), handoff status; manual check list in this file.

## Decisions (from the user, 2026-11-11)

- **Lab:** nginx `stream` server on 22 returns `SSH-2.0-OpenSSH_9.6p1\r\n` and closes. No real SSH (comment +
  README). Still no host ports. `LAB_PORTS` = 22, 80, 443, 8080 (`lab:status` lists them).
- **Type-aware command builder (library):** when `main(..., needs_target_type=True)`, `main()` calls
  `command(target, target_type)`; otherwise `command(target)` exactly as before (the subdomain tools' builders don't
  change). Unit-test both paths in `tools/lib`. Document the signature in team-guide.md. nmap picks ip or port mode
  from the **type** and refuses a value whose shape doesn't match it (clear error, nmap never runs). Reason: the
  server already decided the type; guessing it from the value's shape is the mistake avoided for httpx's parent.
- **`-sV` runs nmap's "version" category scripts automatically.** Accepted (option a). `contacts` says so:
  "…sends service-detection probes, including nmap's built-in version-detection scripts (no other scripts)".
  Confirm the scripts with `-d`; record count and names in §13. The forbidden-flags test stays
  (`-sC`, `--script`, `-O`, `-A`, `-sU`).
- **Install:** nmap (and nmap-common) from the digest-pinned base image's Debian repository, exact version pinned
  (`NMAP_VERSION` in `tools/ports/Dockerfile`); exception to "sha256-checked release" (apt packages are signed; nmap
  ships no checksummed Linux binary). Plain pin, no snapshot.debian.org. A failed `pnpm tools:build ports` must say:
  "the pinned nmap version may have left Debian's repository; bump NMAP_VERSION in tools/ports/Dockerfile". Bump rule
  in §13.
- **Timing:** `timeoutSec` 600, `--host-timeout 480s`, `--max-rate 50`, `--max-retries 1`. Record in §13.
- **Closed/filtered port target:** not an error. Success, no findings; the state stays in the raw output. Only real
  problems (bad XML, a crash, a timeout) use `run.error()`.
- **Findings:** every open port → `port` (`port_value()`), `has_port` from the IP, data `service`, `product`,
  `version`, `extrainfo`, `tunnel` when present; product known → `technology` (`tech_value(product, version)`) with
  `uses_technology` from the port (the contract has `port → technology`). Closed/filtered ports are not findings.
- **Fixtures:** `tools:check` takes exactly one `raw.*`: ip mode is `fixtures/raw.xml` + `expected.json` (checked by
  `tools:check`); port mode is `fixtures/port/raw.xml` + `fixtures/port/expected.json`, replayed by a unit test in
  `test_nmap.py` (which `tools:check` and `pnpm test` run).

## Done

- **Step 1.** `lab/nginx.conf`: a `stream` block (before `http`, so the `listen` order is 22, 80, 443, 8080) with
  `return "SSH-2.0-OpenSSH_9.6p1\r\n";` and a stream access log (`ssh <addr> <status> <bytes>`). The pinned
  `nginx:1.30.6-alpine` is built `--with-stream` (static; checked with `nginx -V`). `lab.ts`: `LAB_PORTS`
  `[22, 80, 443, 8080]`, `lab:up` prints the banner line. `lab/README.md`: the port, "not a real SSH server".
  Checked by hand: from a container on `redwhale-tools`, a connect to `172.29.250.10:22` reads exactly
  `SSH-2.0-OpenSSH_9.6p1\r\n`, then EOF. `portscan.e2e.test.ts` (naabu) still passes: it loops over `LAB_PORTS` and
  naabu's top 100 include 22.

- **Step 2.**
  - **Library** (`tools/lib/redwhale_tool.py`): with `needs_target_type=True`, `main()` builds the command as
    `command(target, target_type)` (also for `--replay`, where it only names the command); without it,
    `command(target)` as before. A builder's `ValueError` refuses the target in both paths (`failed`, nothing run or
    replayed). httpx's and dnsx's builders (both typed tools) take `target_type=None` and ignore it. Four new
    library tests (type passed / not passed / refusal / refusal skips the replay).
  - **Dockerfile:** `ARG NMAP_VERSION=7.95+dfsg-3` (the only version in trixie on 2026-11-11, `apt-cache policy`
    in the pinned base image), `apt-get install --no-install-recommends nmap=… nmap-common=…`, apt lists removed,
    `DEBIAN_FRONTEND=noninteractive`. On failure the build log shows `✗ apt could not install nmap=<v>: the pinned
    nmap version may have left Debian's repository; bump NMAP_VERSION in tools/ports/Dockerfile` (checked with
    `--build-arg NMAP_VERSION=0.0-bogus`). Depends pulled in: nmap-common, liblinear4, liblua5.4-0, libpcap0.8t64,
    libpcre2-8-0, libssh2-1t64, libssl3t64 (no recommends).
  - **Final argv** (every flag in `nmap --help` of 7.95; `-sT` under `-sS/sT/…`; `-oX -` proven by running it):
    `/usr/bin/nmap -sT -Pn -n [-6] -sV --unprivileged --noninteractive --max-rate 50 --max-retries 1
    --host-timeout 480s (--top-ports 100 | -p <port>) -oX - <ip>`. `--unprivileged` (my addition): nmap assumes no
    raw sockets, matching user 10001 with no capability. `--noninteractive`: no keyboard handling.
  - **Version scripts** (`-d` run against the lab, in the image, 10001, `cap-drop ALL`, read-only): "NSE: Loaded 47
    scripts for scanning": exactly the 47 `version`-category scripts in `script.db`: allseeingeye-info amqp-info
    bacnet-info cccam-version db2-das-info docker-version drda-info enip-info fingerprint-strings fox-info
    freelancer-info hnap-info http-server-header http-trane-info https-redirect iax2-version iec61850-mms
    ike-version jdwp-version maxdb-info mcafee-epo-agent mqtt-subscribe murmur-version ndmp-version netbus-version
    omron-info openlookup-info oracle-tns-version ovs-agent-version pptp-version quake1-info quake3-info
    rfc868-time rpc-grind rpcinfo s7-info skypev2-version snmp-info stun-version teamspeak2-version tftp-version
    ubiquiti-discovery ventrilo-info vmware-version wdb-version weblogic-t3-info xmpp-info. Against the lab five
    ran (https-redirect, hnap-info, vmware-version, http-trane-info, http-server-header); the lab's log shows
    `GET /HNAP1`, `GET /evox/about`, `POST /sdk`, `GET /nmaplowercheck…`, `GET /`; no request to
    `elsewhere.redwhale.test` (the redirect is not followed).
  - **run.py:** mode from the type; `split_target` refuses a value that doesn't fit (ip type + non-IP, port type
    without `ip:port/tcp`, `/udp`, IPv6 without brackets, IPv4 with brackets, port 0/>65535, other types).
    Parser (`xml.etree`): root must be `nmaprun`; `runstats/finished exit="error"` → error; a host other than the
    target → error; `<host timedout="true">` (the real 7.95 shape, captured with `--host-timeout 1s`) → error; only
    `state="open"` ports. **Two small additions to the spec, worth a look:** `data.protocol` (`tcp`) like naabu's,
    so the two tools' port data agree; and `service` only when `method="probed"` (a `method="table"` name such as
    `http-proxy` on 8080 is nmap's guess from the port number, not something it found).
  - **tool.json:** `accepts ["ip","port"]`, argv with `--target-type {targetType}`, `timeoutSec` 600, `contacts`
    "connects to TCP ports of {target} (the top 100, or the one port; at most 50 probes per second, connect scan)
    and sends service-detection probes, including nmap's built-in version-detection scripts (no other scripts)".
  - **Fixtures:** real captures by run.py in the image (hardened like a job) against `172.29.250.10` and
    `172.29.250.10:22/tcp`, anonymized to `198.18.0.10`, no edits. ip mode: 22 ssh/OpenSSH/9.6p1/"protocol 2.0",
    80/443(tunnel ssl)/8080 http nginx 1.30.6 → 8 findings. Port mode: 2 findings.
  - **Tests:** `test_nmap.py` (19): argv for ip, IPv6 ip, IPv4 port, IPv6 port; forbidden flags in every mode;
    refusals; refused target never runs nmap; no open ports; closed port target; table-guessed service; IPv6
    value; malformed XML (truncated, not XML, unclosed) directly and through `main()`; empty output/wrong root;
    host timeout; another host; nmap's own error; the port-mode fixture. Server tests that list the repo's tools
    now include nmap (and used `nmap` as their "unknown tool" name: now `no-such-tool`).
  - Lint: fixed three pre-existing `restrict-template-expressions` errors (`LAB_PORTS` in lab.ts and the naabu e2e).
  - One full `pnpm test` run had `tools-fixtures > every tool in the repo passes` fail (output not captured); it
    passed alone, in the next full run and in 3 repeated runs. Watch for it.

## Next action

Step 3: `server/test/nmap.e2e.test.ts` (follow `portscan.e2e.test.ts`): lab up, seed ip 172.29.250.10, scope rules,
passive-only off; nmap without confirm → confirm-required; confirmed run; ports 22/80/443/8080, port 22 data
ssh/OpenSSH/9.6p1, nginx technology; then httpx on lab.redwhale.test and `nginx/1.30.6` corroborated (if spellings
differ: report both values to the user, no alias). Then docs (architecture §11/§13, team-guide, handoff) and the
manual check list.
