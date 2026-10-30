#!/usr/bin/env python3
"""
RED WHALE tool runner - TEMPLATE.

1. Copy this file to tools/<toolname>_runner.py   (e.g. tools/httpx_runner.py)
2. Fill in the three TODO sections below. Don't touch anything else.
3. Test your parser on a saved output (no tool needed):
       python tools/<toolname>_runner.py example.com --replay saved_output.txt
4. Run it for real (only against targets you are allowed to test):
       python tools/<toolname>_runner.py example.com
   It writes output/<toolname>_<target>.json and validates it. ✓ means you're done.

Options:  -o FILE   write somewhere else ( -o - prints to the terminal )
          --replay FILE   parse a saved tool output instead of running the tool
          --timeout SEC   kill the tool after this many seconds (default 900)

Rules (docs/contract.md, docs/team-guide.md):
  - Only use node types / relations from the contract. Need another? Ask the team leader.
  - Never output a real secret: use mask_secret().
  - No IDs, no extra fields. Extra details go in `data`.
"""

import argparse
import json  # noqa: F401  (you'll likely need it in parse())
import sys
import xml.etree.ElementTree as ET  # noqa: F401  (for tools with XML output, e.g. nmap -oX -)

from redwhale import ToolRun, default_output_path, mask_secret, port_value, tool_version  # noqa: F401

# ============================================================================
# TODO 1: the tool's name (lowercase), and how to ask it for its version
# ============================================================================
TOOL = "toolname"
VERSION_COMMAND = ["toolname", "-version"]   # or None if the tool has no version flag


# ============================================================================
# TODO 2: the EXACT command your team agreed on.
# Always use the tool's machine-readable output (JSON / JSONL / XML), never its pretty text.
# Return a list of arguments, not one string.
# ============================================================================
def build_command(target):
    return ["toolname", "-target", target, "-json", "-silent"]


# ============================================================================
# TODO 3: turn the tool's raw output into findings with run.add(...).
#
#   run.add(type, value, parent=(parent_type, parent_value), severity=..., data={...})
#
#   - `relation` is filled in for you when only one fits; pass relation="..." otherwise.
#   - Bad values are skipped and reported, wildcards are skipped, duplicates are merged.
#   - Something went wrong but you still have results?  run.error("what happened")
#
# Common shapes (delete the ones you don't need):
#
#   JSON Lines (one JSON object per line: subfinder -oJ, httpx -json, nuclei -jsonl):
#       for line in output.splitlines():
#           if not line.strip():
#               continue
#           try:
#               item = json.loads(line)
#           except json.JSONDecodeError:
#               run.error(f"not JSON: {line[:100]}")
#               continue
#           run.add("subdomain", item["host"], parent=("domain", target), data={"source": item.get("source")})
#
#   One JSON document:
#       doc = json.loads(output) if output.strip() else {}
#
#   XML (nmap -oX -):
#       root = ET.fromstring(output) if output.strip() else None
#       for host in root.iter("host"): ...
#           run.add("port", port_value(ip, portid, protocol), parent=("ip", ip), data={...})
#
#   Severity: only for vulnerability / secret / leak findings.
#   Secrets:  run.add("secret", "AWS key in /static/app.js", parent=("url", url),
#                     severity="high", data={"preview": mask_secret(raw_key)})
# ============================================================================
def parse(output, run, target):
    for line in output.splitlines():
        line = line.strip()
        if not line:
            continue
        # run.add(...)


# ============================================================================
# Below this line: no changes needed.
# ============================================================================
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
