#!/usr/bin/env python3
"""
wafw00f -> RED WHALE contract v1 (docs/contract.md). ACTIVE: wafw00f sends HTTP requests to the target itself.

    python run.py --target https://lab.northwind.example/waf/ --out out/ --replay fixtures/raw.json
    python run.py --target <a URL you may scan> --out out/          runs wafw00f

The target is a url node. wafw00f 2.4.2 requests exactly that URL (its path included; only query strings are added),
never follows a redirect (-r), and stops at the first WAF signature that matches (never -a, never a proxy):
    1. a normal GET
    2. a GET whose query string has three attack-looking test strings (<script>alert("XSS");</script>, a UNION
       SELECT ... SLEEP(5) SQL injection, ../../etc/passwd) to make a WAF block it; its answer is matched against
       wafw00f's signatures
    3. only when no signature matched ("generic" detection, stops at the first difference): a normal GET again, one
       with requests' own User-Agent instead of a browser's, then the XSS, a plain GET and the SQL injection string
       alone, comparing status codes and the Server header with the normal answer
So 2 requests when a WAF is recognised, at most 7 otherwise.
Findings:
    url --uses_technology--> technology      the WAF, spelled by tech_value: "Shadow Daemon" -> shadow-daemon,
                                             data {waf: true, manufacturer}
                                             generic detection: generic-waf, data {waf: true, manufacturer: null,
                                             generic: true} (weak evidence: something answered attacks differently)
No WAF is a success with no findings. No answer at all ("appears to be down": wafw00f then reports nothing) fails.
"""

import json
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import canonical_url, main, tech_value  # noqa: E402

TOOL = "wafw00f"
WAFW00F = "/opt/wafw00f/bin/wafw00f"  # absolute: the pinned venv's script (tools/http/Dockerfile)
VERSION_COMMAND = [WAFW00F, "--version", "--no-colors"]
REQUEST_TIMEOUT = 10  # seconds per request (-T; wafw00f's default is 7)
GENERIC = "generic-waf"
DOWN = re.compile(r"Site (\S+) appears to be down")
WENT_WRONG = re.compile(r"Something went wrong (.+)")


def build_command(target):
    """The exact wafw00f command. -r: no redirects. -o - -f json: the result as JSON on stdout (wafw00f then prints
    nothing else there; its log goes to stderr). No -a (every signature), -p (proxy), -i, -H, -t, -v."""
    parts = urlsplit(target)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise ValueError(f"wafw00f needs an http:// or https:// url, got {target!r}")
    return [WAFW00F, "-r", "-o", "-", "-f", "json", "--no-colors", "-T", str(REQUEST_TIMEOUT), target]


def same_url(a, b):
    """wafw00f echoes the URL it was given; compare them as the server stores URLs."""
    ca, cb = canonical_url(a), canonical_url(b)
    return ca is not None and cb is not None and ca[0] == cb[0]


def stderr_problem(run):
    """Why wafw00f reported nothing, from its log on stderr (None on --replay)."""
    text = run.stderr or ""
    down = DOWN.search(text)
    wrong = WENT_WRONG.findall(text)
    if down:
        why = f": {wrong[0][:200]}" if wrong else ""
        return f"wafw00f: {down.group(1)} appears to be down (no answer to a normal request){why}"
    if wrong:
        return f"wafw00f: {wrong[0][:300]}"
    return None


def parse(raw, run, target):
    # wafw00f -o - -f json prints one array: one record per URL (one here), e.g.
    #   [{"url": "...", "detected": true, "firewall": "Shadow Daemon", "manufacturer": "Zecure", "trigger_url": "..."}]
    # No WAF: detected false, firewall/manufacturer "None". Generic: firewall "Generic", manufacturer "Unknown".
    # A site that doesn't answer gives [] (and "Site ... appears to be down" on stderr).
    text = raw.strip()
    if not text:
        if not run.errors:
            run.error(stderr_problem(run) or "wafw00f printed nothing")
        return
    try:
        records = json.loads(text)
    except json.JSONDecodeError as e:
        run.error(f"wafw00f's output is not JSON: {e}")
        return
    if not isinstance(records, list):
        run.error(f"wafw00f's output is not a list: {text[:100]}")
        return
    if not records:
        run.error(stderr_problem(run) or f"wafw00f: {target} appears to be down (no result)")
        return

    for rec in records:
        if not isinstance(rec, dict):
            run.error(f"record is not an object: {str(rec)[:100]}")
            continue
        if not same_url(rec.get("url", ""), target):
            run.error(f"record for another URL ignored: {str(rec.get('url'))[:200]}")
            continue
        if rec.get("detected") is not True:
            continue  # no WAF: nothing to report
        firewall = str(rec.get("firewall") or "").strip()
        manufacturer = str(rec.get("manufacturer") or "").strip()
        if not firewall or firewall == "None":
            run.error(f"detected without a WAF name: {str(rec)[:200]}")
            continue
        if firewall == "Generic":
            run.add("technology", GENERIC, parent=("url", target),
                    data={"waf": True, "manufacturer": None, "generic": True})
        else:
            known = manufacturer and manufacturer not in ("None", "Unknown")
            run.add("technology", tech_value(firewall), parent=("url", target),
                    data={"waf": True, "manufacturer": manufacturer if known else None})


def cli(argv=None):
    return main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND, argv=argv)


if __name__ == "__main__":
    sys.exit(cli())
