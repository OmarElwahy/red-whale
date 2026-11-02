#!/usr/bin/env python3
"""
subfinder -> RED WHALE contract v1 (docs/contract.md). The reference script: copy this folder for a new tool.

    python run.py --target example.com --out out/                                   run subfinder
    python run.py --target northwind.example --out out/ --replay fixtures/raw.jsonl  parse the saved sample

Everything shared (arguments, running the tool, raw.txt, result.json, validation) is in tools/lib/redwhale_tool.py.
This file only says which command to run and how to read its output.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import json_lines, main  # noqa: E402

TOOL = "subfinder"
VERSION_COMMAND = ["subfinder", "-version"]


def build_command(target):
    # -oJ: one JSON object per line (machine-readable; never parse the pretty text)
    # -cs: every source that reported a host, not just the first
    # -silent: only results on stdout; -duc: no update check (no extra network call)
    # -max-time 8: stop enumerating after 8 minutes, before the runner's 10-minute kill
    return ["subfinder", "-d", target, "-oJ", "-cs", "-silent", "-duc", "-max-time", "8"]


def parse(raw, run, target):
    # A line looks like: {"host":"api.example.com","input":"example.com","sources":["crtsh","anubis"]}
    for item in json_lines(raw, run):
        host = item.get("host") if isinstance(item, dict) else None
        if not isinstance(host, str):
            run.error(f"line without a host: {str(item)[:100]}")
            continue
        sources = item.get("sources") or ([item["source"]] if item.get("source") else [])
        run.add_subdomain(host, target, data={"sources": sorted(sources)} if sources else None)


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND))
