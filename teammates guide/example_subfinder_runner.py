#!/usr/bin/env python3
"""
WORKED EXAMPLE: TEMPLATE_runner.py filled in for subfinder. Read this next to the template.

Try it without subfinder installed:
    python example_subfinder_runner.py example.com --replay samples/subfinder.jsonl -o -
"""

import argparse
import json
import sys

from redwhale import ToolRun, default_output_path, tool_version

# TODO 1
TOOL = "subfinder"
VERSION_COMMAND = ["subfinder", "-version"]


# TODO 2
def build_command(target):
    return ["subfinder", "-d", target, "-oJ", "-silent"]


# TODO 3: subfinder -oJ prints one JSON object per line: {"host": "...", "input": "...", "source": "..."}
def parse(output, run, target):
    run.add("domain", target)  # the root node everything hangs off
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            run.error(f"not JSON: {line[:100]}")
            continue
        run.add("subdomain", item.get("host"), parent=("domain", target), data={"source": item.get("source")})


# Below this line: unchanged from the template.
def main():
    ap = argparse.ArgumentParser(description=f"Run {TOOL} and write RED WHALE contract-v1 JSON.")
    ap.add_argument("target", help="domain, IP, CIDR or URL to scan")
    ap.add_argument("-o", "--output", help="output file (default output/<tool>_<target>.json; '-' = stdout)")
    ap.add_argument("--replay", metavar="FILE", help="parse a saved tool output instead of running the tool")
    ap.add_argument("--timeout", type=int, default=900, help="seconds before the tool is killed")
    args = ap.parse_args()

    version = None if args.replay or not VERSION_COMMAND else tool_version(VERSION_COMMAND)
    run = ToolRun(TOOL, args.target, tool_version=version)
    output = run.execute(build_command(args.target), timeout=args.timeout, replay_file=args.replay)
    try:
        parse(output, run, args.target)
    except Exception as e:  # a parser crash still produces a valid file that says what broke
        run.error(f"parser crashed: {type(e).__name__}: {e}")

    path = None if args.output == "-" else (args.output or default_output_path(TOOL, args.target))
    sys.exit(run.save(path))


if __name__ == "__main__":
    main()
