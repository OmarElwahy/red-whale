"""
RED WHALE helper for tool scripts (contract v1, contract.md). Standard library only.

You don't edit this file. Your runner (copied from TEMPLATE_runner.py) uses it like this:

    run = ToolRun("subfinder", target)
    output = run.execute(["subfinder", "-d", target, "-oJ", "-silent"])
    for line in output.splitlines():
        run.add("subdomain", "api.example.com", parent=("domain", target))
    sys.exit(run.save("output/subfinder_example.com.json"))

What it does for you:
  - records started_at / finished_at / command / errors / status
  - cleans values (lowercase hosts and emails, strips trailing dots, compresses IPs, lowercases URL hosts)
  - skips wildcards and empty values, merges duplicate findings
  - fills in `relation` when only one relation fits the parent/child types
  - checks every value with validate_output.py and validates the whole file before saving
"""

import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate_output as contract  # noqa: E402  (the team validator, same folder)

SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"]

# Windows consoles (cp1252) can't print every character. Messages degrade to '?' instead of crashing,
# and JSON written to stdout (e.g. `> out.json`) is always UTF-8.
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(errors="replace")
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def now():
    """Current time in the contract's format: 2026-10-29T10:00:00Z"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    """Progress/diagnostics go to stderr, so stdout can carry the JSON."""
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------- value helpers

def port_value(ip, port, protocol="tcp"):
    """Build a `port` value: port_value("93.184.216.34", 443) -> "93.184.216.34:443/tcp"."""
    ip = str(ip).strip().strip("[]")
    host = f"[{ip}]" if ":" in ip else ip
    return f"{host}:{int(port)}/{protocol.lower()}"


def mask_secret(secret, keep=4):
    """Never output a real secret. mask_secret("AKIAABCDEFGHWXYZ") -> "AKIA****WXYZ"."""
    s = str(secret)
    if len(s) <= keep * 2:
        return "*" * len(s)
    return f"{s[:keep]}****{s[-keep:]}"


def clean_value(ntype, value):
    """Fix harmless formatting differences. Anything still wrong is reported by check_value()."""
    v = str(value).strip()
    if ntype in ("domain", "subdomain"):
        v = v.lower().rstrip(".")
    elif ntype == "email":
        v = v.lower()
    elif ntype == "ip":
        try:
            v = str(ipaddress.ip_address(v.strip("[]")))
        except ValueError:
            pass
    elif ntype == "port":
        m = re.match(r"^(.+):(\d{1,5})/(tcp|udp)$", v, re.IGNORECASE)
        if m:
            v = port_value(m.group(1), m.group(2), m.group(3))
    elif ntype == "url":
        parts = urlsplit(v)
        if parts.scheme and parts.netloc:
            v = urlunsplit((parts.scheme.lower(), parts.netloc.lower().rstrip("."), parts.path, parts.query, ""))
    elif ntype == "certificate":
        v = v.lower().replace(":", "")
    return v


def find_relation(parent_type, child_type):
    """The only relation allowed between these types, or None if there are zero or several."""
    matches = [r for r, (parents, children) in contract.RELATIONS.items()
               if parent_type in parents and child_type in children]
    return matches[0] if len(matches) == 1 else None


# ---------------------------------------------------------------- the run

class ToolRun:
    def __init__(self, tool, target, tool_version=None):
        self.tool = tool.lower()
        self.target = target
        self.tool_version = tool_version
        self.command = ""
        self.started_at = now()
        self.finished_at = None
        self.errors = []
        self.skipped = []          # findings dropped because their value was invalid
        self._findings = {}        # key -> finding, keeps insertion order

    # -- running the tool ---------------------------------------------------

    def execute(self, cmd, timeout=900, replay_file=None):
        """
        Run `cmd` (a list of arguments) and return its stdout as text.
        Never raises: problems are recorded in `errors` and you get whatever output there was.

        replay_file: read the tool output from this file instead of running the tool.
        Use it to test your parser on a saved output without installing/running the tool.
        """
        self.command = shlex.join(cmd)
        self.started_at = now()
        try:
            if replay_file:
                log(f"[replay] reading {replay_file} instead of running: {self.command}")
                with open(replay_file, encoding="utf-8", errors="replace") as fh:
                    return fh.read()
            log(f"[run] {self.command}")
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                                  errors="replace", timeout=timeout)
            if proc.returncode != 0:
                self.error(f"exit code {proc.returncode}: {proc.stderr.strip()[-500:]}")
            return proc.stdout
        except FileNotFoundError:
            self.error(f"'{cmd[0]}' not found; is it installed and on PATH?")
        except subprocess.TimeoutExpired as e:
            self.error(f"timed out after {timeout}s")
            out = e.stdout or ""
            return out.decode("utf-8", "replace") if isinstance(out, bytes) else out
        except OSError as e:
            self.error(str(e))
        finally:
            self.finished_at = now()
        return ""

    def error(self, message):
        """Record a problem. Any error makes the status 'partial' (or 'failed' with no findings)."""
        self.errors.append(str(message)[:500])

    # -- findings -----------------------------------------------------------

    def add(self, ntype, value, parent=None, relation=None, severity=None, data=None):
        """
        Add one finding. Returns True if it was kept.

        ntype     one of the node types in contract.md section 3
        value     the value; it is cleaned (see clean_value) and then checked
        parent    (type, value) tuple of the node this hangs off, or None for a top-level node
        relation  optional when only one relation fits parent/child types
        severity  info / low / medium / high / critical (vulnerabilities, secrets, leaks)
        data      dict of tool-specific details (status codes, titles, banners, template IDs ...)
        """
        if value is None or not str(value).strip():
            return False
        value = clean_value(ntype, value)
        if ntype in ("domain", "subdomain") and value.startswith("*"):
            return False  # wildcards are not hosts (contract section 3)

        finding = {"type": ntype, "value": value}
        problem = contract.check_value(ntype, value) if ntype in contract.NODE_TYPES \
            else f"unknown type '{ntype}'"

        if parent is not None:
            ptype, pvalue = parent
            pvalue = clean_value(ptype, pvalue)
            parent_problem = contract.check_value(ptype, pvalue) if ptype in contract.NODE_TYPES \
                else "is not a valid node type"
            if parent_problem:
                problem = problem or f"parent {ptype} '{pvalue}' {parent_problem}"
            relation = relation or find_relation(ptype, ntype)
            if relation is None:
                problem = problem or f"no relation fits {ptype} -> {ntype}; pass relation= or ask the team leader"
            elif relation not in contract.RELATIONS:
                problem = problem or f"relation '{relation}' is not in the contract"
            elif ptype not in contract.RELATIONS[relation][0] or ntype not in contract.RELATIONS[relation][1]:
                problem = problem or f"'{relation}' can't link {ptype} -> {ntype}"
            finding["parent"] = {"type": ptype, "value": pvalue}
            finding["relation"] = relation
        elif relation is not None:
            problem = problem or "relation given without a parent"

        if severity is not None:
            severity = str(severity).lower()
            if severity not in SEVERITY_ORDER:
                problem = problem or f"severity '{severity}' is not one of {', '.join(SEVERITY_ORDER)}"
            finding["severity"] = severity
        if data:
            finding["data"] = dict(data)

        if problem:
            self.skipped.append(f"{ntype} '{value}': {problem}")
            return False

        key = (ntype, value, json.dumps(finding.get("parent"), sort_keys=True))
        existing = self._findings.get(key)
        if existing is None:
            self._findings[key] = finding
        else:  # same finding twice: merge details, keep the highest severity
            if data:
                existing["data"] = {**existing.get("data", {}), **data}
            if severity and SEVERITY_ORDER.index(severity) > SEVERITY_ORDER.index(existing.get("severity", "info")):
                existing["severity"] = severity
        return True

    # -- output -------------------------------------------------------------

    def result(self):
        """The contract-v1 JSON object."""
        findings = list(self._findings.values())
        errors = list(self.errors)
        if self.skipped:
            errors.append(f"skipped {len(self.skipped)} finding(s) with invalid values; first: {self.skipped[0]}")
        status = "failed" if errors and not findings else "partial" if errors else "success"
        doc = {"contract_version": contract.CONTRACT_VERSION, "tool": self.tool}
        if self.tool_version:
            doc["tool_version"] = self.tool_version
        doc.update({
            "target": self.target,
            "command": self.command,
            "started_at": self.started_at,
            "finished_at": self.finished_at or now(),
            "status": status,
            "errors": errors,
            "findings": findings,
        })
        return doc

    def save(self, path=None):
        """
        Validate and write the JSON (to `path`, or stdout if None). Returns an exit code:
        0 = valid file written, 1 = the output breaks the contract (a bug in your parser).
        """
        doc = self.result()
        text = json.dumps(doc, indent=2, ensure_ascii=False)
        if path:
            os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
            with open(path, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(text + "\n")
        else:
            print(text)

        for s in self.skipped:
            log(f"    skipped {s}")
        errors, warnings = contract.validate(doc)
        where = path or "stdout"
        if errors:
            log(f"✗ {where}: output breaks the contract ({len(errors)} error(s)) - fix your parser")
            for e in errors:
                log(f"    ERROR  {e}")
        else:
            log(f"✓ {where}  ({len(doc['findings'])} findings, status {doc['status']})")
        for w in warnings:
            log(f"    warn   {w}")
        return 1 if errors else 0


def tool_version(cmd, pattern=r"v?(\d+(?:\.\d+)+)"):
    """Best-effort version string from e.g. ["subfinder", "-version"]; None if it can't be found."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(pattern, proc.stdout + proc.stderr)
    return m.group(1) if m else None


def default_output_path(tool, target):
    """output/<tool>_<target>.json, with characters that are unsafe in file names replaced."""
    safe = re.sub(r"[^A-Za-z0-9._-]+", "_", target).strip("_")
    return os.path.join("output", f"{tool}_{safe}.json")
