#!/usr/bin/env python3
"""
nmap -> RED WHALE contract v1 (docs/contract.md). ACTIVE: it connects to the target's TCP ports and sends
service-detection probes, including nmap's built-in version-detection scripts (-sV runs the "version" category).

    python run.py --target 198.18.0.10 --target-type ip --out out/ --replay fixtures/raw.xml
    python run.py --target 198.18.0.10:22/tcp --target-type port --out out/ --replay fixtures/port/raw.xml
    python run.py --target <an IP you may test> --target-type ip --out out/        runs nmap

The mode comes from the target's TYPE (the server passes it, {targetType}), never from the value's shape:
  ip     its top 100 TCP ports
  port   only that port (value ip:port/tcp, IPv6 bracketed); a value that doesn't fit its type is refused
Findings: every open port -> `port` (ip --has_port--> ip:port/tcp) with what nmap identified in its data; a known
product -> `technology` (port --uses_technology--> name/version). Closed and filtered ports are not findings (a closed
port target is a success with no findings; nmap's own answer stays in raw.txt).
The XML is read with xml.etree (the standard library), never with regular expressions.
"""

import ipaddress
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import main, port_value, tech_value  # noqa: E402

TOOL = "nmap"
NMAP = "/usr/bin/nmap"  # absolute: never whatever else is called nmap on PATH (Debian's package installs it here)
VERSION_COMMAND = [NMAP, "--version"]
HOST_TIMEOUT = "480s"  # below the job's 600 s (the script gets 570 s), so nmap stops first and still writes its XML

# Never in any argv (test_nmap.py checks every mode): scripts beyond -sV's own, OS detection, UDP.
FORBIDDEN = ("-sC", "--script", "-O", "-A", "-sU")


def split_target(target, target_type):
    """(ip, port or None) for the target, by its type. Raises ValueError for a value that doesn't fit the type."""
    if target_type == "ip":
        try:
            return str(ipaddress.ip_address(target)), None
        except ValueError:
            raise ValueError(f"refusing target {target!r}: an ip target must be one IP address") from None
    if target_type == "port":
        refused = ValueError(f"refusing target {target!r}: a port target must be ip:port/tcp (IPv6 as [ip]:port/tcp)")
        hostport, _, protocol = target.rpartition("/")
        host, _, port = hostport.rpartition(":")
        if protocol == "udp":
            raise ValueError(f"refusing target {target!r}: nmap here scans TCP only (no UDP)")
        if protocol != "tcp" or not port.isdigit() or not 1 <= int(port) <= 65535:
            raise refused
        bracketed = host.startswith("[") and host.endswith("]")
        try:
            ip = ipaddress.ip_address(host[1:-1] if bracketed else host)
        except ValueError:
            raise refused from None
        if (ip.version == 6) != bracketed:  # IPv6 needs its brackets, IPv4 has none
            raise refused
        return str(ip), int(port)
    raise ValueError(f"refusing target {target!r}: nmap runs on an ip or a port, not a {target_type}")


def build_command(target, target_type):
    ip, port = split_target(target, target_type)
    # Flags checked against `nmap --help` of 7.95 (docs/phase-6c4-progress.md has the final argv).
    #   -sT -Pn -n            connect scan (no raw packets), no host discovery, no DNS
    #   -6                    an IPv6 target
    #   -sV                   service/version detection, default intensity (also runs the "version" scripts)
    #   --unprivileged        assume no raw sockets (user 10001, no capability), so nothing tries them
    #   --noninteractive      no keyboard interaction
    #   --max-rate 50 --max-retries 1 --host-timeout 480s   conservative; a filtered port can't eat the budget
    #   --top-ports 100 | -p <port>   the IP's top 100 TCP ports, or only the port target's port
    #   -oX -                 XML to stdout; no other output file
    ports = ["--top-ports", "100"] if port is None else ["-p", str(port)]
    return [NMAP, "-sT", "-Pn", "-n", *(["-6"] if ":" in ip else []), "-sV",
            "--unprivileged", "--noninteractive",
            "--max-rate", "50", "--max-retries", "1", "--host-timeout", HOST_TIMEOUT,
            *ports, "-oX", "-", ip]


def parse(raw, run, target):
    if not raw.strip():
        if not run.errors:  # a refused target or a failed run already says why
            run.error("nmap wrote no XML output")
        return
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        run.error(f"nmap's XML output could not be read ({e}); nothing was reported")
        return
    if root.tag != "nmaprun":
        run.error(f"not nmap XML output (root element <{root.tag}>)")
        return
    finished = root.find("runstats/finished")
    if finished is not None and finished.get("exit") == "error":
        run.error(f"nmap reported an error: {finished.get('errormsg') or 'no message'}")

    ip, _ = split_target(target, run.target_type)
    for host in root.iter("host"):
        address = host.find("address")
        addr = address.get("addr") if address is not None else None
        try:
            same = addr is not None and ipaddress.ip_address(addr) == ipaddress.ip_address(ip)
        except ValueError:
            same = False
        if not same:
            run.error(f"a host other than the target in nmap's output: {addr!r}")
            continue
        if host.get("timedout") == "true":
            run.error(f"nmap gave up on {ip} after --host-timeout {HOST_TIMEOUT}; its ports are not reported")
            continue
        for p in host.iterfind("ports/port"):
            state = p.find("state")
            if state is None or state.get("state") != "open":
                continue
            protocol, portid = (p.get("protocol") or "").lower(), p.get("portid") or ""
            if protocol != "tcp" or not portid.isdigit():
                run.error(f"an open port nmap reported oddly: {protocol}/{portid}")
                continue
            value = port_value(ip, portid, protocol)
            data = {"protocol": protocol}
            service = p.find("service")
            if service is not None:
                if service.get("method") == "probed":  # "table" is only a guess from the port number
                    data["service"] = service.get("name")
                for key in ("product", "version", "extrainfo", "tunnel"):
                    data[key] = service.get(key)
            data = {k: v for k, v in data.items() if v}
            run.add("port", value, parent=("ip", ip), data=data)
            if data.get("product"):
                run.add("technology", tech_value(data["product"], data.get("version")), parent=("port", value))


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND, needs_target_type=True))
