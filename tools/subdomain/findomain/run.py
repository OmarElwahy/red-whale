#!/usr/bin/env python3
"""
findomain -> RED WHALE contract v1 (docs/contract.md). Same shape as tools/subdomain/subfinder/run.py.

    python run.py --target example.com --out out/
    python run.py --target northwind.example --out out/ --replay fixtures/raw.txt

findomain 10 has no JSON output; -q (quiet) prints only the hosts, one per line, so that is what we parse.
It resolves nothing unless asked (-r / -i), so this run stays passive.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import main  # noqa: E402

TOOL = "findomain"
VERSION_COMMAND = ["findomain", "--version"]


def build_command(target):
    # -t: the target; -q: hosts only (no banners, no per-source progress)
    return ["findomain", "-t", target, "-q"]


def parse(raw, run, target):
    for line in raw.splitlines():
        host = line.strip()
        if host:
            run.add_subdomain(host, target)


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND))
