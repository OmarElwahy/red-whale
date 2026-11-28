"""
RED WHALE tool helper (contract v1, docs/contract.md). Standard library only. You don't edit this file.

Every tool script (tools/<group>/<tool>/run.py) is three things plus one call:

    TOOL = "subfinder"
    def build_command(target):            # the exact command, as a list (never a shell string)
        return ["subfinder", "-d", target, "-oJ", "-silent"]
    def parse(raw, run, target):          # raw tool output -> run.add(...) / run.add_subdomain(...)
        ...
    if __name__ == "__main__":
        main(TOOL, parse, command=build_command, version_command=["subfinder", "-version"])

main() gives every script the same interface, on a laptop and in the container:

    python run.py --target example.com --out out/            run the tool, write out/raw.txt + out/result.json
    python run.py --target example.com --out out/ --replay fixtures/raw.jsonl   parse a saved output instead

and does the rest: refuses option-like targets, runs the tool with a timeout, keeps its raw output (capped),
cleans values, skips wildcards and duplicates, fills in `relation`, catches parser crashes, sets status/errors,
checks the result with tools/validate_output.py and writes it.
"""

import argparse
import ipaddress
import json
import os
import re
import shlex
import subprocess
import sys
from datetime import datetime, timezone
from urllib.parse import urlsplit, urlunsplit

# tools/validate_output.py (in the container: /opt/redwhale/validate_output.py) is the one set of contract rules.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import validate_output as contract  # noqa: E402

RAW_CAP_BYTES = 5 * 1024 * 1024
DEFAULT_TIMEOUT = 900
SEVERITY_ORDER = ["info", "low", "medium", "high", "critical"]

# Windows consoles (cp1252) can't print every character: degrade to '?' instead of crashing.
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(errors="replace")


def now():
    """Current time in the contract's format: 2026-10-29T10:00:00Z"""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(msg):
    """Progress and diagnostics go to stderr (the runner keeps it as the job's stderr)."""
    print(msg, file=sys.stderr, flush=True)


# ---------------------------------------------------------------- value helpers

def port_value(ip, port, protocol="tcp"):
    """port_value("93.184.216.34", 443) -> "93.184.216.34:443/tcp" (IPv6 gets brackets)."""
    ip = str(ip).strip().strip("[]")
    host = f"[{ip}]" if ":" in ip else ip
    return f"{host}:{int(port)}/{protocol.lower()}"


def tech_value(name, version=None):
    """
    A `technology` value, always spelled one way, so two tools (or two runs) land on one node:

        tech_value("Nginx", "1.30.6")            -> "nginx/1.30.6"
        tech_value("Microsoft ASP.NET", "4.0")   -> "microsoft-asp.net/4.0"
        tech_value("PHP")                        -> "php"

    The rule: lowercase; in the name, every run of spaces or slashes becomes one "-" (a "/" only ever separates the
    version); the version loses its spaces ("/" in it becomes "-" too); no version -> the name alone. Returns "" for
    an empty name (run.add then skips it).
    """
    n = re.sub(r"[\s/]+", "-", str(name if name is not None else "").strip().lower()).strip("-")
    if not n:
        return ""
    v = re.sub(r"\s+", "", str(version if version is not None else "")).lower().replace("/", "-").strip("-")
    return f"{n}/{v}" if v else n


def mask_secret(secret, keep=4):
    """Never output a real secret. mask_secret("AKIAABCDEFGHWXYZ") -> "AKIA****WXYZ"."""
    s = str(secret)
    if len(s) <= keep * 2:
        return "*" * len(s)
    return f"{s[:keep]}****{s[-keep:]}"


def clean_host(host):
    """Lowercase, no surrounding space or trailing dot, punycode for non-ASCII names. '' if it can't be."""
    h = str(host).strip().rstrip(".").lower()
    if not h.isascii():
        try:
            h = h.encode("idna").decode("ascii")
        except UnicodeError:
            return ""
    return h


def clean_value(ntype, value):
    """Fix harmless formatting differences. Anything still wrong is reported by the validator."""
    v = str(value).strip()
    if ntype in ("domain", "subdomain"):
        v = clean_host(v)
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


# ---------------------------------------------------------------- DNS resolvers

RESOLV_CONF = "/etc/resolv.conf"
NO_RESOLVER = "no system resolver found; refusing to use public ones"


def resolvers(path=None):
    """
    The machine's own DNS servers, from /etc/resolv.conf (in a job container: Docker's 127.0.0.11), as "ip:53"
    ("[v6]:53" for IPv6). [] if there is no file or no usable nameserver line.

    Tools that resolve names themselves (httpx, dnsx, ...) fall back to public resolvers (8.8.8.8, 1.1.1.1, ...)
    when they aren't given any: outside services the target's name would leak to. Such a tool passes
    resolver_args() in its command and calls main(..., needs_resolvers=True), which refuses to run it without one.
    """
    found = []
    try:
        with open(path or RESOLV_CONF, encoding="utf-8") as fh:
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


def resolver_args(flag="-r"):
    """[flag, "ip:53,..."] with the machine's own resolvers, or [] if there are none. Only [] when replaying a
    fixture: a real run without resolvers is refused by main(..., needs_resolvers=True) before the command is built."""
    own = resolvers()
    return [flag, ",".join(own)] if own else []


def find_relation(parent_type, child_type):
    """The only relation allowed between these types, or None if there are zero or several."""
    matches = [r for r, (parents, children) in contract.RELATIONS.items()
               if parent_type in parents and child_type in children]
    return matches[0] if len(matches) == 1 else None


def json_lines(raw, run):
    """Each non-empty line of `raw` parsed as JSON (JSON Lines output: subfinder -oJ, httpx -json, ...).
    Lines that aren't JSON are reported with run.error() and skipped."""
    for n, line in enumerate(raw.splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            run.error(f"line {n} is not JSON: {line[:100]}")


# ---------------------------------------------------------------- the run

class ToolRun:
    def __init__(self, tool, target, tool_version=None):
        self.tool = tool.lower()
        self.target = target
        # The target node's type ("domain", "subdomain"...), from --target-type; None if the tool doesn't take it.
        self.target_type = None
        self.tool_version = tool_version
        self.command = ""
        self.started_at = now()
        self.finished_at = None
        self.errors = []
        self.skipped = []      # findings dropped because their value was invalid
        self.ignored = 0       # names that are legitimately not findings (wildcards, other domains, the apex)
        self._findings = {}    # key -> finding, in insertion order

    def error(self, message):
        """Record a problem. Any error makes the status 'partial' (or 'failed' with no findings)."""
        self.errors.append(str(message)[:500])

    def run_command(self, cmd, timeout=DEFAULT_TIMEOUT):
        """Run `cmd` (a list of arguments, no shell) and return its stdout. Never raises: problems become errors."""
        self.command = shlex.join(cmd)
        log(f"[run] {self.command}")
        try:
            proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                  timeout=timeout, stdin=subprocess.DEVNULL)
            if proc.stderr.strip():
                log(proc.stderr.rstrip()[-4000:])
            if proc.returncode != 0:
                self.error(f"exit code {proc.returncode}: {proc.stderr.strip()[-300:]}")
            return proc.stdout
        except FileNotFoundError:
            self.error(f"'{cmd[0]}' not found; is it installed and on PATH?")
        except subprocess.TimeoutExpired as e:
            self.error(f"timed out after {timeout}s; kept the output so far")
            out = e.stdout or ""
            return out.decode("utf-8", "replace") if isinstance(out, bytes) else out
        except OSError as e:
            self.error(str(e))
        return ""

    def add(self, ntype, value, parent=None, relation=None, severity=None, data=None):
        """
        Add one finding. Returns True if it was kept.

        ntype     a node type from docs/contract.md section 3
        value     cleaned (clean_value) and then checked with the team validator
        parent    (type, value) of the node this hangs off, or None for a top-level node
        relation  optional when only one relation fits the parent/child types
        severity  info / low / medium / high / critical (vulnerabilities, secrets, leaks)
        data      dict of tool-specific details (sources, status codes, titles, ...)
        """
        if value is None or not str(value).strip():
            return False
        value = clean_value(ntype, value)
        if ntype in ("domain", "subdomain") and value.startswith("*"):
            self.ignored += 1
            return False  # wildcards are not hosts (contract section 3)

        finding = {"type": ntype, "value": value}
        problem = contract.check_value(ntype, value) if ntype in contract.NODE_TYPES else f"unknown type '{ntype}'"

        if parent is not None:
            ptype, pvalue = parent
            pvalue = clean_value(ptype, pvalue)
            if ptype not in contract.NODE_TYPES:
                problem = problem or f"parent type '{ptype}' is not a node type"
            else:
                parent_problem = contract.check_value(ptype, pvalue)
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
        else:  # the same finding again: merge details, keep the highest severity
            if data:
                existing["data"] = _merge_data(existing.get("data", {}), data)
            if severity and SEVERITY_ORDER.index(severity) > SEVERITY_ORDER.index(existing.get("severity", "info")):
                existing["severity"] = severity
        return True

    def add_subdomain(self, host, domain, data=None):
        """
        A subdomain of `domain` (the target). Skips, without an error, what a subdomain tool legitimately returns
        but isn't one: wildcards (*.x), the domain itself, and names outside it (crt.sh certificates list those).
        """
        h = clean_host(host)
        d = clean_host(domain)
        if not h or h.startswith("*") or h == d or not h.endswith("." + d):
            self.ignored += 1
            return False
        return self.add("subdomain", h, parent=("domain", d), data=data)

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

    def write(self, out_dir, raw):
        """Write raw.txt (the tool's output, capped) and result.json into out_dir. Returns the problems the
        validator found (empty = the file follows the contract)."""
        os.makedirs(out_dir, exist_ok=True)
        data = raw.encode("utf-8", "replace")
        if len(data) > RAW_CAP_BYTES:
            note = f"\n[RED WHALE: raw output truncated at {RAW_CAP_BYTES} of {len(data)} bytes]\n".encode()
            data = data[:RAW_CAP_BYTES] + note
        with open(os.path.join(out_dir, "raw.txt"), "wb") as fh:
            fh.write(data)

        doc = self.result()
        problems, warnings = contract.validate(doc)
        path = os.path.join(out_dir, "result.json")
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(doc, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
        os.replace(tmp, path)

        for s in self.skipped[:20]:
            log(f"    skipped {s}")
        if problems:
            log(f"✗ {path}: breaks the contract ({len(problems)} problem(s)); fix the parser")
            for p in problems:
                log(f"    ERROR  {p}")
        else:
            log(f"✓ {path}  ({len(doc['findings'])} findings, {self.ignored} ignored, status {doc['status']})")
        for w in warnings:
            log(f"    warn   {w}")
        return problems


def _merge_data(old, new):
    """Merge two data dicts; a key both have with different values keeps both (as a sorted list)."""
    merged = dict(old)
    for k, v in new.items():
        if k not in merged or merged[k] == v:
            merged[k] = v
            continue
        a = merged[k] if isinstance(merged[k], list) else [merged[k]]
        b = v if isinstance(v, list) else [v]
        merged[k] = sorted({json.dumps(x, sort_keys=True): x for x in a + b}.values(), key=lambda x: json.dumps(x))
    return merged


def tool_version(cmd, pattern=r"v?(\d+(?:\.\d+)+)"):
    """Best-effort version from e.g. ["subfinder", "-version"]; None if it can't be found."""
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                              timeout=30, stdin=subprocess.DEVNULL)
    except (OSError, subprocess.TimeoutExpired):
        return None
    m = re.search(pattern, proc.stdout + proc.stderr)
    return m.group(1) if m else None


def safe_target(value):
    """The target as one argument for the tool. Refuses anything a tool could read as an option or a second
    argument (a leading '-', whitespace, control characters): argument injection."""
    if not value or value.startswith("-") or any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value):
        raise ValueError(f"refusing target {value!r}: empty, starts with '-', or contains whitespace/control characters")
    return value


# ---------------------------------------------------------------- entry point

TARGET_TYPES = ("domain", "subdomain", "ip", "port", "url")


def main(tool, parse, command=None, fetch=None, version_command=None, needs_target_type=False, needs_resolvers=False,
         argv=None):
    """
    The whole script. Give it exactly one of:
      command(target) -> list    the tool's command line (run with a timeout; its stdout is the raw output)
      fetch(target, run, timeout) -> str    for tools that are an HTTP API, not a program (e.g. crt.sh);
                                            set run.command to what was requested, report problems with run.error

    needs_target_type=True: the script needs the target node's type (run.target_type), e.g. to name the target as a
    finding's parent. The server passes it as --target-type ({targetType} in tool.json's argv); without it the
    script stops with an error instead of guessing (a wrong type would be another node). With it, the command
    builder is called as command(target, target_type) (without it, command(target)), so a tool can pick its mode from
    the type the server decided and refuse a value that doesn't fit it (raise ValueError).

    needs_resolvers=True: the tool resolves names itself and gets resolver_args() in its command. With no nameserver
    in /etc/resolv.conf the tool is not run at all: the result is `failed` with NO_RESOLVER (without our resolvers it
    would quietly ask public ones). --replay skips the check: nothing runs, so nothing is resolved.
    """
    if (command is None) == (fetch is None):
        raise TypeError("main() needs exactly one of command= or fetch=")
    ap = argparse.ArgumentParser(description=f"Run {tool} and write RED WHALE contract-v1 JSON.")
    ap.add_argument("--target", required=True, help="what to run against, e.g. example.com")
    ap.add_argument("--target-type", choices=TARGET_TYPES,
                    help="the target node's type (the server passes it; required by tools that need it)")
    ap.add_argument("--out", required=True, help="directory for raw.txt and result.json (in the container: /out)")
    ap.add_argument("--replay", metavar="FILE", help="parse this saved tool output instead of running the tool")
    ap.add_argument("--timeout", type=int, default=int(os.environ.get("REDWHALE_TOOL_TIMEOUT", DEFAULT_TIMEOUT)),
                    help="seconds before the tool is stopped (default: $REDWHALE_TOOL_TIMEOUT or 900)")
    args = ap.parse_args(argv)

    try:
        target = safe_target(args.target.strip())
    except ValueError as e:
        log(str(e))
        return 2
    if needs_target_type and not args.target_type:
        log(f"{tool} needs --target-type ({', '.join(TARGET_TYPES)}): the target node's type, which the server passes "
            "as {targetType} in tool.json's argv. It is never guessed: a wrong type would make a duplicate node.")
        return 2

    version = None if args.replay or not version_command else tool_version(version_command)
    run = ToolRun(tool, target, tool_version=version)
    run.target_type = args.target_type

    def build(t):
        return command(t, run.target_type) if needs_target_type else command(t)

    if args.replay:
        try:
            run.command = shlex.join(build(target)) if command else f"{tool} {target} (replayed)"
        except ValueError as e:  # the builder refuses this target: nothing is replayed either
            run.error(str(e))
            log(f"✗ {e}; {tool} was not run")
            run.command = f"{tool} {target} (refused)"
            args.replay = None
        if args.replay:
            log(f"[replay] {args.replay} instead of: {run.command}")
            with open(args.replay, encoding="utf-8", errors="replace") as fh:
                raw = fh.read()
        else:
            raw = ""
    elif needs_resolvers and not resolvers():
        run.error(NO_RESOLVER)
        log(f"✗ {NO_RESOLVER} (no nameserver in {RESOLV_CONF}); {tool} was not run")
        raw = ""
    elif command:
        try:
            cmd = build(target)  # a command builder may refuse a target its tool would misread (ValueError)
        except ValueError as e:
            run.error(str(e))
            log(f"✗ {e}; {tool} was not run")
            cmd = None
        raw = run.run_command(cmd, timeout=args.timeout) if cmd else ""
    else:
        try:
            raw = fetch(target, run, args.timeout)
        except Exception as e:  # a crash in fetch still produces a result that says what broke
            run.error(f"fetch crashed: {type(e).__name__}: {e}")
            raw = ""

    try:
        parse(raw, run, target)
    except Exception as e:  # a parser crash still produces a valid file that says what broke
        run.error(f"parser crashed: {type(e).__name__}: {e}")
    run.finished_at = now()
    problems = run.write(args.out, raw)
    return 1 if problems else 0
