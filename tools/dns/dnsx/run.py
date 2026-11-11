#!/usr/bin/env python3
"""
dnsx -> RED WHALE contract v1 (docs/contract.md). Passive: it asks only the system DNS resolver, never the target.

    python run.py --target lab.northwind.example --target-type subdomain --out out/ --replay fixtures/raw.jsonl
    python run.py --target <a name> --target-type subdomain --out out/        runs dnsx

Findings: one `ip` per A/AAAA answer, target --resolves_to--> ip. The target itself is never a finding (resolving
the name it was given isn't discovering it). A CNAME goes in each ip's data (`cname`). A CNAME with no A/AAAA answer
(dangling) is no finding: it is only noted in the log (and is in raw.txt). The target's node type comes from
--target-type (the server fills {targetType}); it is never guessed.
DNS only through the machine's resolver (-r from /etc/resolv.conf); with none, the helper refuses to run dnsx.
No brute-force or wordlist mode, ever (no -d, no -w).
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import clean_host, json_lines, log, main, resolver_args  # noqa: E402

TOOL = "dnsx"
DNSX = "/usr/local/bin/dnsx"  # absolute: never whatever else is called dnsx on PATH
VERSION_COMMAND = [DNSX, "-version"]


def build_command(target, target_type=None):  # the type isn't needed here: only the parser uses it
    # -l takes "file or comma separated or stdin" (v1.3.1): a target that is an existing path or holds a comma would
    # make dnsx read a file or resolve several names. Hostnames have neither; refuse anything that does.
    if "," in target or os.path.exists(target):
        raise ValueError(f"refusing target {target!r}: dnsx -l would read it as a file or a list")
    # Flags checked against `dnsx -h` of v1.3.1 (docs/phase-6c3-progress.md has the final argv).
    #   -l target                     exactly this one name (no -d/-w: never brute-force)
    #   -a -aaaa -cname               these record types only
    #   -j -silent -nc -duc           JSON lines only, no colors, no update check (no extra call)
    #   -r <own resolvers>            the machine's resolver only, never dnsx's public defaults; with none,
    #                                 main(needs_resolvers=True) refuses to run dnsx at all
    #   -rl 10 -t 5 -retry 2          conservative
    return [DNSX, "-l", target, "-a", "-aaaa", "-cname",
            "-j", "-silent", "-nc", "-duc",
            "-rl", "10", "-t", "5", "-retry", "2",
            *resolver_args()]


def parse(raw, run, target):
    # A line (one per name that answered):
    # {"host":"lab.northwind.example","ttl":600,"resolver":["127.0.0.11:53"],"a":["198.18.0.10"],
    #  "aaaa":["2001:db8::10"],"cname":["edge.cdn.example"],"status_code":"NOERROR","timestamp":"…"}
    ttype = run.target_type
    for item in json_lines(raw, run):
        if not isinstance(item, dict):
            run.error(f"line is not an object: {str(item)[:100]}")
            continue
        host = clean_host(item.get("host") or "")
        if host != clean_host(target):
            run.error(f"answer for another name: {str(item.get('host'))[:100]}")
            continue
        cnames = [clean_host(c) for c in item.get("cname") or [] if clean_host(c)]
        ips = [*(item.get("a") or []), *(item.get("aaaa") or [])]
        if cnames and not ips:
            log(f"note: {host} is a CNAME to {', '.join(cnames)} with no A/AAAA answer (dangling); no finding")
            continue
        # One CNAME -> a string; a chain (a -> b -> c) -> the names in the order dnsx gives them.
        data = {"cname": cnames[0] if len(cnames) == 1 else cnames} if cnames else None
        for ip in ips:
            run.add("ip", ip, parent=(ttype, target), data=data)


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND, needs_target_type=True,
                  needs_resolvers=True))
