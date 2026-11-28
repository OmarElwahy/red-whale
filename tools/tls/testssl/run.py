#!/usr/bin/env python3
"""
testssl.sh -> RED WHALE contract v1 (docs/contract.md). ACTIVE: testssl.sh makes TLS handshakes with the target.

    python run.py --target https://lab.northwind.example/ --target-type url --out out/ --replay fixtures/raw.json
    python run.py --target 198.18.0.10:443/tcp --target-type port --out out/      runs testssl.sh
    python run.py ... --checks protocols,defaults        tests only: fewer checks (never in tool.json)

The target is an https:// url (SNI from its host; the port from the URL, default 443) or a TCP port (`ip:port/tcp`;
no SNI, no hostname to check the certificate against). testssl.sh 3.2.5 runs these checks, and no others:
    -p   protocols (SSLv2 ... TLS 1.3, ALPN)          -s   cipher categories (NULL, export, LOW, 3DES, CBC, AEAD)
    -S   server defaults and the certificate          -U   known TLS flaws (Heartbleed, CCS, Ticketbleed, ROBOT,
                                                           renegotiation, CRIME, BREACH, POODLE, fallback SCSV,
                                                           SWEET32, FREAK, DROWN, LOGJAM, BEAST, LUCKY13, Winshock, RC4)
Never -h (HTTP headers), STARTTLS, --phone-out (CRL/OCSP downloads), -c (client simulation), -e/-E.
`--ip one`: testssl tests ONE address of the host (the first its lookup returns; another run may get another one
behind a CDN), named in every finding's data as `ip`. `--nodns min`: its only DNS queries are the host's A and AAAA
records, through the system resolver (no PTR, CAA or MX; probed with a logging dig). BREACH sends one HTTP GET for
the URL's path (TLS-compressed answers); everything else is TLS handshakes with that one address and port.

Findings (url target; a port target is itself the port, and the vulnerabilities hang off it):
    ip --has_port--> port --serves--> url              the address and port testssl tested, like httpx (they merge)
    port --has_certificate--> certificate              SHA-256 fingerprint; data subject (CN), sans, issuer,
                                                       not_before/not_after (UTC, ISO 8601), trusted (chain of
                                                       trust OK), ip. A server with an RSA and an ECDSA certificate
                                                       gives two.
    url|port --has_vulnerability--> vulnerability      every result of severity LOW or higher: its CVE when testssl
                                                       names one (the first; all of them in data.cves), else
                                                       testssl's id (without " <hostCert#N>"). OK, INFO and WARN
                                                       stay in raw.txt (the whole JSON).
On a port target testssl has no hostname, so `cert_trust` ("does not match supplied URI") is not reported: testssl
itself warns that trust results are wrong for a bare IP.
No TLS on the port, a closed/refused port, or a name that doesn't resolve: `failed` with that reason, no findings.
"""

import ipaddress
import json
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import log, main, port_value  # noqa: E402

TOOL = "testssl"
TESTSSL = "/opt/testssl/testssl.sh"  # absolute: the pinned release (tools/tls/Dockerfile)
OPENSSL = "/opt/testssl/bin/openssl.Linux.x86_64"  # testssl's own build (old protocols and ciphers)
VERSION_COMMAND = [TESTSSL, "--version"]  # standalone: testssl refuses --version with other options
CHECKS = {"protocols": "-p", "ciphers": "-s", "defaults": "-S", "vulnerabilities": "-U"}
ALL_CHECKS = tuple(CHECKS)
TIMEOUT_FLAGS = ("--connect-timeout", "10", "--openssl-timeout", "10")  # seconds; no hanging handshakes

SEVERITIES = {"LOW": "low", "MEDIUM": "medium", "HIGH": "high", "CRITICAL": "critical"}
CVE_ID = re.compile(r"^CVE-\d{4}-\d{4,}$", re.IGNORECASE)
CERT_SUFFIX = re.compile(r"^(.*?)\s*<hostCert#(\d+)>$")
NOT_TLS = "doesn't seem to be a TLS/SSL enabled server"
CANT_CONNECT = re.compile(r"can't connect|unable to open a socket|tcp connect problem", re.IGNORECASE)
# With --ip one, a host whose lookup returns nothing gives "couldn't identify supplied 'CMDLINE_IP'" (probed).
NO_ADDRESS = re.compile(r"CMDLINE_IP|no ip ?v?[46]? ?address|can't resolve|could not resolve|no a record", re.IGNORECASE)
CERT_DATE = re.compile(r"^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})$")
PORT_TARGET = re.compile(r"^(\[[0-9A-Fa-f:.]+\]|[0-9.]+|[0-9A-Fa-f:]+):(\d{1,5})/(tcp|udp)$")
MAX_FINDING_LEN = 300


class Target:
    """What testssl is given, and what the findings hang off."""

    def __init__(self, value, target_type):
        self.value, self.type = value, target_type
        if target_type == "url":
            parts = urlsplit(value)
            if parts.scheme.lower() != "https" or not parts.hostname:
                raise ValueError(f"testssl needs an https:// url, got {value!r} (an http:// url has no TLS to test)")
            try:
                self.port = parts.port or 443
            except ValueError:
                raise ValueError(f"bad port in {value!r}") from None
            self.host = parts.hostname.lower()
            self.arg = value  # testssl reads the scheme, host (SNI), port and path (BREACH) from the URI
        elif target_type == "port":
            m = PORT_TARGET.match(value)
            if not m:
                raise ValueError(f"not a port value (ip:port/tcp): {value!r}")
            if m.group(3) != "tcp":
                raise ValueError(f"testssl tests TCP ports only, got {value!r}")
            self.host, self.port = m.group(1).strip("[]"), int(m.group(2))
            ipaddress.ip_address(self.host)  # ValueError if it isn't an address
            self.arg = f"[{self.host}]:{self.port}" if ":" in self.host else f"{self.host}:{self.port}"
        else:
            raise ValueError(f"testssl accepts an https:// url or a TCP port, not a {target_type or 'missing'} type")
        if not 0 < self.port < 65536:
            raise ValueError(f"bad port in {value!r}")

    @property
    def ipv6(self):
        try:
            return ipaddress.ip_address(self.host).version == 6
        except ValueError:
            return False

    @property
    def hostport(self):
        return f"[{self.host}]:{self.port}" if self.ipv6 else f"{self.host}:{self.port}"


def build_command(target, target_type, json_path, checks=ALL_CHECKS):
    """The exact testssl.sh command (a list, no shell). Raises ValueError for a target testssl can't test."""
    t = Target(target, target_type)
    cmd = [TESTSSL, "--openssl", OPENSSL]
    cmd += [CHECKS[c] for c in ALL_CHECKS if c in checks]
    cmd += ["--jsonfile", json_path, "--nodns", "min", "--ip", "one", "--warnings", "batch", "--color", "0",
            "--quiet", "--disable-rating", *TIMEOUT_FLAGS]
    if t.ipv6:
        cmd.append("-6")
    cmd.append(t.arg)
    return cmd


def parse_checks(value):
    checks = tuple(c.strip() for c in value.split(",") if c.strip())
    unknown = [c for c in checks if c not in CHECKS]
    if not checks or unknown:
        raise ValueError(f"--checks takes a comma-separated subset of {', '.join(ALL_CHECKS)}; got {value!r}")
    return checks


def make_fetch(checks):
    def fetch(target, run, timeout):
        """Run testssl.sh; its JSON file is the raw output (stdout is the screen report, not kept)."""
        json_path = os.path.join(tempfile.mkdtemp(prefix="redwhale-testssl-"), "testssl.json")
        try:
            cmd = build_command(target, run.target_type, json_path, checks)
        except ValueError as e:
            run.error(str(e))
            run.command = f"{TOOL} {target} (refused)"
            log(f"✗ {e}; testssl was not run")
            return ""
        run.run_command(cmd, timeout=timeout)
        try:
            with open(json_path, encoding="utf-8", errors="replace") as fh:
                return fh.read()
        except FileNotFoundError:
            return ""
    return fetch


def load_items(raw, run):
    """testssl's flat JSON: a list of {id, ip, port, severity, finding, [cve], [cwe]}. A run stopped at its time
    limit leaves the list unclosed: what was written is still read."""
    text = raw.strip()
    if not text:
        return None
    for candidate in (text, text.rstrip(",") + "\n]"):
        try:
            items = json.loads(candidate)
            break
        except json.JSONDecodeError:
            continue
    else:
        run.error("testssl's JSON file could not be read")
        return None
    if not isinstance(items, list):
        run.error("testssl's JSON is not a list")
        return None
    return [i for i in items if isinstance(i, dict) and isinstance(i.get("id"), str)]


def tested_address(items):
    """The address testssl tested: "host/ip" in each result's ip field ("/" on global notes)."""
    for item in items:
        _, _, ip = str(item.get("ip") or "").partition("/")
        try:
            return str(ipaddress.ip_address(ip.strip().strip("[]")))
        except ValueError:
            continue
    return None


def iso_utc(value):
    m = CERT_DATE.match(str(value or "").strip())
    return f"{m.group(1)}T{m.group(2)}:00Z" if m else (str(value).strip() or None)


def failure(items, t):
    """Why nothing was tested (no TLS, can't connect, no address), or None."""
    for item in items:
        finding = str(item.get("finding") or "")
        if NOT_TLS in finding:
            return f"no TLS service on {t.hostport}"
    for item in items:
        if str(item.get("severity")).upper() != "FATAL":
            continue
        finding = " ".join(str(item.get("finding") or "").split())
        if CANT_CONNECT.search(finding):
            return f"can't connect to {t.hostport}: closed, refused or filtered ({finding[:150]})"
        if NO_ADDRESS.search(finding):
            return f"{t.host} did not resolve: no address through the system resolver ({finding[:150]})"
        return f"testssl: {finding[:300]}"
    return None


def parse(raw, run, target):
    try:
        t = Target(target, run.target_type)
    except ValueError as e:
        if not run.errors:
            run.error(str(e))
        return
    items = load_items(raw, run)
    if items is None:
        if not run.errors:
            run.error("testssl wrote no results")
        return

    reason = failure(items, t)
    if reason:
        # The specific reason replaces run_command's generic "exit code 245/246/..." line. Nothing is reported.
        run.errors[:] = [e for e in run.errors if not e.startswith("exit code ")] + [reason]
        return

    ip = tested_address(items)
    certs, vulns = {}, []
    for item in items:
        m = CERT_SUFFIX.match(item["id"])
        base, n = (m.group(1), int(m.group(2))) if m else (item["id"], 1)
        severity = str(item.get("severity") or "").upper()
        if base.startswith("cert_") or base == "cert":
            certs.setdefault(n, {})[base] = item
        if severity in SEVERITIES:
            vulns.append((base, n if m else None, severity, item))

    fingerprints = {}
    port_node = None
    if certs or vulns:
        if t.type == "url":
            if ip is None:
                run.error("testssl named no tested address: the port and certificate can't be placed")
            else:
                port_node = ("port", port_value(ip, t.port, "tcp"))
                run.add("port", port_node[1], parent=("ip", ip), data={"service": "https"})
                run.add("url", target, parent=port_node, relation="serves")
        else:
            port_node = ("port", target)

    for n in sorted(certs):
        fields = certs[n]

        def val(key, _f=fields):
            return str((_f.get(key) or {}).get("finding") or "").strip()

        fp = val("cert_fingerprintSHA256").lower().replace(":", "")
        if not re.fullmatch(r"[0-9a-f]{64}", fp):
            if fields:
                run.error(f"certificate #{n} without a SHA-256 fingerprint")
            continue
        fingerprints[n] = fp
        if port_node is None:
            continue
        chain = fields.get("cert_chain_of_trust") or {}
        data = {
            "subject": val("cert_commonName") or None,
            "sans": val("cert_subjectAltName").split() if val("cert_subjectAltName") not in ("", "--") else [],
            "issuer": val("cert_caIssuers") or None,
            "not_before": iso_utc(val("cert_notBefore")),
            "not_after": iso_utc(val("cert_notAfter")),
            "trusted": str(chain.get("severity")).upper() == "OK" if chain else None,
            "ip": ip,
        }
        run.add("certificate", fp, parent=port_node, relation="has_certificate",
                data={k: v for k, v in data.items() if v is not None})

    parent = ("url", target) if t.type == "url" else ("port", target)
    for base, n, severity, item in vulns:
        if t.type == "port" and base == "cert_trust":
            continue  # no hostname to check against: testssl's own cmdline_ip-target warning
        cves = sorted({c.upper() for c in str(item.get("cve") or "").split() if CVE_ID.match(c)})
        data = {"id": base, "finding": " ".join(str(item.get("finding") or "").split())[:MAX_FINDING_LEN]}
        if item.get("cwe"):
            data["cwe"] = str(item["cwe"]).strip()
        if len(cves) > 1:
            data["cves"] = cves
        if n is not None and n in fingerprints:
            data["certificate"] = fingerprints[n]
        if ip:
            data["ip"] = ip
        run.add("vulnerability", cves[0] if cves else base, parent=parent, relation="has_vulnerability",
                severity=SEVERITIES[severity], data=data)


def split_checks(argv):
    """--checks a,b (tests only) out of argv; the rest goes to main()."""
    rest, checks = [], ALL_CHECKS
    it = iter(argv)
    for arg in it:
        if arg == "--checks":
            checks = parse_checks(next(it, ""))
        elif arg.startswith("--checks="):
            checks = parse_checks(arg.split("=", 1)[1])
        else:
            rest.append(arg)
    return checks, rest


def cli(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        checks, rest = split_checks(argv)
    except ValueError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 2
    return main(TOOL, parse, fetch=make_fetch(checks), version_command=VERSION_COMMAND, needs_target_type=True,
                needs_resolvers=True, argv=rest)


if __name__ == "__main__":
    sys.exit(cli())
