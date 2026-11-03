#!/usr/bin/env python3
"""
httpx -> RED WHALE contract v1 (docs/contract.md). ACTIVE: it sends HTTP(S) requests to the target itself.

    python run.py --target lab.northwind.example --target-type subdomain --out out/ --replay fixtures/raw.jsonl
    python run.py --target <a host you may test> --target-type subdomain --out out/        runs httpx

Findings, one chain per answering port (docs/contract.md section 4):
    target --resolves_to--> ip --has_port--> ip:port/tcp --serves--> url --uses_technology--> technology
The target's node type comes from --target-type (the server fills {targetType}); it is never guessed.
Status code, title, web server and a redirect's Location go in the url's data. A redirect target is NOT a finding:
httpx is run without -fr, so it never follows one, and we never report the other host.
"""

import ipaddress
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import json_lines, main, port_value, tech_value  # noqa: E402

TOOL = "httpx"
HTTPX = "/usr/local/bin/httpx"  # absolute: never whatever else is called httpx on PATH
VERSION_COMMAND = [HTTPX, "-version"]
DEFAULT_PORTS = {"http": "80", "https": "443"}


def resolvers(path="/etc/resolv.conf"):
    """The machine's own DNS servers (in a job container: Docker's 127.0.0.11). Without -r, httpx also asks public
    resolvers (8.8.8.8, 1.1.1.1, ...): outside services the target's name would leak to. [] if there's no file."""
    found = []
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                parts = line.split()
                if len(parts) >= 2 and parts[0] == "nameserver":
                    try:
                        ip = ipaddress.ip_address(parts[1])
                    except ValueError:
                        continue
                    found.append(f"[{ip}]:53" if ip.version == 6 else f"{ip}:53")
    except OSError:
        return []
    return found


def build_command(target):
    # Flags checked against `httpx -h` of v1.12.0 (docs/phase-6c2-progress.md has the final argv).
    #   -u target -p http:80,https:443 -nf   probe exactly http://target:80 and https://target:443, report both
    #   (no -fr)                             never follow a redirect (httpx's default); its Location is kept as data
    #   -j -silent -nc -no-stdin -duc        JSON lines only, no colors, no stdin, no update check (no extra call)
    #   -sc -title -server -td -ip -location status, title, web server, technologies, host IP, redirect target
    #   -r <own resolvers>                   DNS only through the machine's resolver, never public ones
    #   -rl 5 -t 5 -timeout 10 -retries 1    conservative: at most 5 requests a second
    cmd = [HTTPX, "-u", target, "-p", "http:80,https:443", "-nf",
           "-j", "-silent", "-nc", "-no-stdin", "-duc",
           "-sc", "-title", "-server", "-td", "-ip", "-location",
           "-rl", "5", "-t", "5", "-timeout", "10", "-retries", "1"]
    own = resolvers()
    if own:
        cmd += ["-r", ",".join(own)]
    return cmd


def url_value(scheme, host, port, path):
    """The URL as the server stores it (WHATWG href): no default port, a path (at least "/")."""
    scheme = str(scheme).lower()
    port = str(port or "")
    netloc = host if not port or DEFAULT_PORTS.get(scheme) == port else f"{host}:{port}"
    return f"{scheme}://{netloc}{path or '/'}"


def parse(raw, run, target):
    # A line (one per answering port):
    # {"port":"443","url":"https://host:443","input":"host","title":"…","scheme":"https","webserver":"nginx/1.30.6",
    #  "host":"host","host_ip":"198.18.0.10","path":"/","a":["198.18.0.10"],"tech":["Nginx:1.30.6"],
    #  "status_code":200,"location":"https://other/","failed":false,…}
    ttype = run.target_type
    for item in json_lines(raw, run):
        if not isinstance(item, dict):
            run.error(f"line is not an object: {str(item)[:100]}")
            continue
        if item.get("failed"):
            continue  # nothing answered on that port
        scheme, port = item.get("scheme"), item.get("port")
        host = item.get("host") or target
        if scheme not in DEFAULT_PORTS or not str(port or "").isdigit():
            run.error(f"line without a scheme/port: {str(item)[:100]}")
            continue
        url = url_value(scheme, host, port, item.get("path"))

        data = {"status_code": item.get("status_code")}
        for key in ("title", "webserver", "location"):
            if item.get(key):
                data[key] = item[key]

        ip = item.get("host_ip") or next(iter(item.get("a") or []), None)
        if ip:
            run.add("ip", ip, parent=(ttype, target))
            pvalue = port_value(ip, port, "tcp")
            run.add("port", pvalue, parent=("ip", ip), data={"service": scheme})
            url_parent = ("port", pvalue)
        else:
            url_parent = (ttype, target)  # no address reported: the url hangs off the target (serves)
        if not run.add("url", url, parent=url_parent, data=data):
            continue
        for tech in item.get("tech") or []:
            name, _, version = str(tech).partition(":")
            run.add("technology", tech_value(name, version), parent=("url", url))


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND, needs_target_type=True))
