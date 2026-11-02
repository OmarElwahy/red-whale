#!/usr/bin/env python3
"""
assetfinder -> RED WHALE contract v1 (docs/contract.md). Same shape as tools/subdomain/subfinder/run.py.

    python run.py --target example.com --out out/
    python run.py --target northwind.example --out out/ --replay fixtures/raw.txt

assetfinder has no JSON (or any machine-readable) output mode, so this is the text case: one host per line.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import main  # noqa: E402

TOOL = "assetfinder"
# assetfinder has no version flag; v0.1.1 is pinned in the Dockerfile.
VERSION_COMMAND = None


def build_command(target):
    # --subs-only: only names ending in the target. It matches on the suffix alone, so "xexample.com" can still
    # come back for "example.com"; add_subdomain() drops those.
    return ["assetfinder", "--subs-only", target]


def parse(raw, run, target):
    for line in raw.splitlines():
        host = line.strip()
        if host:
            run.add_subdomain(host, target)


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND))
