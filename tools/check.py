#!/usr/bin/env python3
"""
Self-check for a tool folder, before you hand it in (docs/team-guide.md). Run it with:

    pnpm tools:check <tool>            e.g. pnpm tools:check subfinder
    pnpm tools:check --all
    pnpm tools:check <tool> --update   write fixtures/expected.json from what the parser produces now

(pnpm first checks tool.json with the server's own rules, then runs this file.) For tools/<group>/<tool>/ it checks:

  1. the files are there: tool.json, run.py, fixtures/raw.<ext> (exactly one), fixtures/NOTE.md, fixtures/expected.json
  2. run.py --replay fixtures/raw.* runs and writes result.json and raw.txt
  3. result.json follows the contract (tools/validate_output.py)
  4. its tool name, target, status, errors and findings equal fixtures/expected.json
  5. the folder's own unit tests (test_*.py), if it has any, pass

Exit code 0 = everything passed. No network: the tool itself never runs.
"""

import argparse
import json
import os
import subprocess
import sys
import tempfile

TOOLS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS)
import validate_output as contract  # noqa: E402

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def tool_dirs():
    """{tool name: folder} for every tools/<group>/<tool>/ with a tool.json."""
    found = {}
    for group in sorted(os.listdir(TOOLS)):
        gdir = os.path.join(TOOLS, group)
        if not os.path.isfile(os.path.join(gdir, "group.json")):
            continue
        for tool in sorted(os.listdir(gdir)):
            if os.path.isfile(os.path.join(gdir, tool, "tool.json")):
                found[tool] = os.path.join(gdir, tool)
    return found


def key(f):
    """A finding's identity: the same value under two parents (nginx on http:// and https://) is two findings."""
    parent = f.get("parent") or {}
    return (str(f.get("type")), str(f.get("value")), str(parent.get("type", "")), str(parent.get("value", "")))


class Report:
    def __init__(self, name):
        self.name = name
        self.failed = 0

    def ok(self, msg):
        print(f"  ✓ {msg}")

    def bad(self, msg, details=()):
        self.failed += 1
        print(f"  ✗ {msg}")
        for d in list(details)[:15]:
            print(f"      {d}")
        if len(list(details)) > 15:
            print(f"      … and {len(list(details)) - 15} more")


def check(name, folder, update=False):
    r = Report(name)
    print(f"{name}  ({os.path.relpath(folder, os.path.dirname(TOOLS))})")
    fixtures = os.path.join(folder, "fixtures")

    # 1. files
    missing = [p for p in ("tool.json", "run.py", "fixtures/NOTE.md") if not os.path.isfile(os.path.join(folder, p))]
    raws = sorted(f for f in os.listdir(fixtures) if f.startswith("raw.")) if os.path.isdir(fixtures) else []
    if len(raws) != 1:
        missing.append(f"fixtures/raw.<ext> (exactly one; found {len(raws)})")
    if missing:
        r.bad("files missing", missing)
        return r
    r.ok("tool.json, run.py, fixtures/raw + NOTE.md present")
    raw = os.path.join(fixtures, raws[0])
    expected_path = os.path.join(fixtures, "expected.json")
    expected = None
    if os.path.isfile(expected_path):
        with open(expected_path, encoding="utf-8") as fh:
            expected = json.load(fh)
    elif not update:
        r.bad("fixtures/expected.json missing", ["create it with: pnpm tools:check " + name + " --update (then read it!)"])
        return r
    target = (expected or {}).get("target", "northwind.example")
    # The target node's type, for scripts that take --target-type ({targetType} in tool.json's argv). Set it in
    # expected.json once (a stub {"target": ..., "target_type": ...} before the first --update); --update keeps it.
    target_type = (expected or {}).get("target_type")

    # 2. replay
    with tempfile.TemporaryDirectory() as out:
        type_args = ["--target-type", target_type] if target_type else []
        proc = subprocess.run(
            [sys.executable, "-I", os.path.join(folder, "run.py"), "--target", target, *type_args, "--out", out, "--replay", raw],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
        )
        result_path = os.path.join(out, "result.json")
        if not os.path.isfile(result_path):
            r.bad(f"run.py --replay wrote no result.json (exit code {proc.returncode})", proc.stderr.strip().splitlines()[-15:])
            return r
        with open(result_path, encoding="utf-8") as fh:
            doc = json.load(fh)
        has_raw = os.path.isfile(os.path.join(out, "raw.txt"))
    r.ok(f"run.py --replay {os.path.relpath(raw, folder)} wrote result.json ({len(doc.get('findings', []))} findings)")
    if not has_raw:
        r.bad("run.py wrote no raw.txt")

    # 3. contract
    errors, warnings = contract.validate(doc)
    if errors:
        r.bad("result.json breaks the contract", errors)
    else:
        r.ok("result.json follows the contract" + (f" ({len(warnings)} warning(s))" if warnings else ""))
    if doc.get("tool") != name:
        r.bad(f"result.json says tool '{doc.get('tool')}', but the folder is '{name}' (TOOL in run.py)")

    # 4. expected
    current = {"target": target, **({"target_type": target_type} if target_type else {}),
               "status": doc.get("status"), "errors": doc.get("errors"),
               "findings": sorted(doc.get("findings", []), key=key)}
    if update:
        with open(expected_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps(current, indent=2, ensure_ascii=False) + "\n")
        r.ok(f"wrote fixtures/expected.json ({len(current['findings'])} findings): read it and check it is right")
    else:
        problems = []
        for field in ("status", "errors"):
            if expected.get(field) != current[field]:
                problems.append(f"{field}: expected {expected.get(field)!r}, got {current[field]!r}")
        want = {key(f): f for f in expected.get("findings", [])}
        got = {key(f): f for f in current["findings"]}
        problems += [f"missing finding  {k[0]} {k[1]}" for k in want if k not in got]
        problems += [f"extra finding    {k[0]} {k[1]}" for k in got if k not in want]
        problems += [f"different        {k[0]} {k[1]}: expected {want[k]}, got {got[k]}" for k in want if k in got and want[k] != got[k]]
        if problems:
            r.bad("result differs from fixtures/expected.json", problems)
        else:
            r.ok(f"matches fixtures/expected.json ({len(want)} findings)")

    # 5. unit tests
    tests = [f for f in os.listdir(folder) if f.startswith("test_") and f.endswith(".py")]
    if tests:
        proc = subprocess.run([sys.executable, "-I", "-m", "unittest", "discover", "-s", folder, "-p", "test_*.py"],
                              capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120)
        if proc.returncode == 0:
            r.ok(f"unit tests pass ({', '.join(sorted(tests))})")
        else:
            r.bad("unit tests fail", proc.stderr.strip().splitlines()[-15:])
    return r


def main(argv=None):
    ap = argparse.ArgumentParser(description="Check a RED WHALE tool folder before handing it in.")
    ap.add_argument("tool", nargs="?", help="tool name (its folder name), e.g. subfinder")
    ap.add_argument("--all", action="store_true", help="check every tool")
    ap.add_argument("--update", action="store_true", help="write fixtures/expected.json from the current parser")
    args = ap.parse_args(argv)
    found = tool_dirs()
    if args.all:
        names = list(found)
    elif args.tool:
        if args.tool not in found:
            print(f"✗ no tool '{args.tool}'. Tools: {', '.join(found) or 'none'} (a tool is tools/<group>/<tool>/tool.json)")
            return 2
        names = [args.tool]
    else:
        ap.print_help()
        return 2
    reports = [check(n, found[n], update=args.update) for n in names]
    bad = [r.name for r in reports if r.failed]
    print()
    print(f"✗ {len(bad)} of {len(reports)} failed: {', '.join(bad)}" if bad else f"✓ all {len(reports)} passed")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
