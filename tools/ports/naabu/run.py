#!/usr/bin/env python3
"""
naabu -> RED WHALE contract v1 (docs/contract.md). ACTIVE: it opens TCP connections to the target itself.

    python run.py --target 198.18.0.10 --out out/ --replay fixtures/raw.jsonl
    python run.py --target <an IP you may test> --out out/        runs naabu

Findings: one `port` per open port, ip --has_port--> ip:port/tcp (the protocol also in its data). The target is
always an IP (tool.json accepts only ip), so the parent is ("ip", target); nothing is resolved.
A connect scan: no raw packets, no capability, no host discovery (ICMP would need raw sockets).
"""

import ipaddress
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import json_lines, main, port_value  # noqa: E402

TOOL = "naabu"
NAABU = "/usr/local/bin/naabu"  # absolute: never whatever else is called naabu on PATH
VERSION_COMMAND = [NAABU, "-version"]


def build_command(target):
    # -host takes a comma list and hostnames; the target must be exactly one IP (no DNS, no second host).
    try:
        ip = str(ipaddress.ip_address(target))
    except ValueError:
        raise ValueError(f"refusing target {target!r}: naabu runs only against one IP address") from None
    # Flags checked against `naabu -h` of v2.7.0 (docs/phase-6c3-progress.md has the final argv).
    #   -host ip -s c -Pn          this one IP, connect scan (no raw sockets), no host discovery (ICMP needs raw)
    #   -tp 100                    the top 100 TCP ports
    #   -rate 50 -c 10             at most 50 connections a second, 10 workers
    #   -timeout 2s -retries 1     conservative
    #   -j -silent -nc -duc -no-stdin   JSON lines only, no colors, no update check (no extra call), no stdin
    return [NAABU, "-host", ip, "-s", "c", "-Pn", "-tp", "100",
            "-rate", "50", "-c", "10", "-timeout", "2s", "-retries", "1",
            "-j", "-silent", "-nc", "-duc", "-no-stdin"]


def parse(raw, run, target):
    # A line (one per open port):
    # {"ip":"198.18.0.10","timestamp":"…","port":443,"protocol":"tcp","tls":false}
    for item in json_lines(raw, run):
        if not isinstance(item, dict):
            run.error(f"line is not an object: {str(item)[:100]}")
            continue
        ip, port = item.get("ip"), item.get("port")
        protocol = str(item.get("protocol") or "tcp").lower()
        if not ip or not str(port).isdigit() or protocol not in ("tcp", "udp"):
            run.error(f"line without an ip/port/protocol: {str(item)[:100]}")
            continue
        if ip != target:
            run.error(f"open port on another address: {str(item)[:100]}")
            continue
        run.add("port", port_value(ip, port, protocol), parent=("ip", target), data={"protocol": protocol})


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND))
