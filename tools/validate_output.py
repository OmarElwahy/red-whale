#!/usr/bin/env python3
"""
RED WHALE tool-output validator (contract v1).

Usage:
    python3 tools/validate_output.py output.json [more.json ...]

Checks a tool script's JSON output against docs/contract.md.
No third-party packages needed. Exit code 0 = all files valid, 1 = errors found.
"""

import ipaddress
import json
import re
import sys
from datetime import datetime

CONTRACT_VERSION = 1

NODE_TYPES = {
    "domain", "subdomain", "ip", "port", "url", "technology",
    "vulnerability", "email", "secret", "certificate", "leak",
}

# relation -> (allowed parent types, allowed child types)
RELATIONS = {
    "has_subdomain":     ({"domain"}, {"subdomain"}),
    "resolves_to":       ({"domain", "subdomain"}, {"ip"}),
    "has_port":          ({"ip"}, {"port"}),
    "serves":            ({"port", "subdomain", "domain"}, {"url"}),
    "has_url":           ({"url"}, {"url"}),
    "uses_technology":   ({"url", "port"}, {"technology"}),
    "has_vulnerability": ({"url", "port", "technology", "subdomain", "ip"}, {"vulnerability"}),
    "has_certificate":   ({"port", "subdomain"}, {"certificate"}),
    "has_email":         ({"domain", "subdomain", "url"}, {"email"}),
    "has_secret":        ({"url"}, {"secret"}),
    "found_in_leak":     ({"email"}, {"leak"}),
}

SEVERITIES = {"info", "low", "medium", "high", "critical"}
STATUSES = {"success", "partial", "failed"}

TOP_REQUIRED = {
    "contract_version": int, "tool": str, "target": str, "command": str,
    "started_at": str, "finished_at": str, "status": str, "errors": list, "findings": list,
}
TOP_OPTIONAL = {"tool_version": str}
FINDING_FIELDS = {"type", "value", "parent", "relation", "severity", "data"}

HOST_RE = re.compile(r"^(?=.{1,253}$)([a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$")
EMAIL_RE = re.compile(r"^[a-z0-9._%+'-]+@([a-z0-9-]+\.)+[a-z]{2,63}$")
SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
URL_RE = re.compile(r"^(https?)://([^/:?#]+)(:\d{1,5})?([/?#].*)?$")
PORT_RE = re.compile(r"^(.+):(\d{1,5})/(tcp|udp)$")


def parse_time(s):
    if not isinstance(s, str) or not s.endswith("Z"):
        return None
    try:
        return datetime.fromisoformat(s[:-1] + "+00:00")
    except ValueError:
        return None


def is_ip(s):
    try:
        ipaddress.ip_address(s)
        return True
    except ValueError:
        return False


def check_value(ntype, value):
    """Return an error message if `value` is badly formatted for `ntype`, else None."""
    if not isinstance(value, str) or not value.strip():
        return "value must be a non-empty string"
    if value != value.strip():
        return "value has leading/trailing spaces"

    if ntype in ("domain", "subdomain"):
        if value != value.lower():
            return "must be lowercase"
        if "://" in value or "/" in value:
            return "must not contain a scheme or path"
        if value.endswith("."):
            return "must not end with a dot"
        if value.startswith("*"):
            return "wildcards like *.example.com are not allowed; skip them or put them in data"
        if ":" in value:
            return "must not contain a port"
        if not HOST_RE.match(value):
            return "is not a valid hostname"
    elif ntype == "ip":
        if not is_ip(value):
            return "is not a valid IPv4/IPv6 address"
    elif ntype == "port":
        m = PORT_RE.match(value)
        if not m:
            return "must look like ip:port/tcp, e.g. 93.184.216.34:443/tcp"
        ip, port, _ = m.groups()
        if not is_ip(ip.strip("[]")):
            return f"'{ip}' is not a valid IP"
        if not 1 <= int(port) <= 65535:
            return "port number out of range"
    elif ntype == "url":
        m = URL_RE.match(value)
        if not m:
            return "must be a full URL starting with http:// or https://"
        host = m.group(2)
        if host != host.lower():
            return "host part of the URL must be lowercase"
    elif ntype == "email":
        if not EMAIL_RE.match(value):
            return "must be a valid lowercase email address"
    elif ntype == "certificate":
        if not SHA256_RE.match(value):
            return "must be a SHA-256 fingerprint: 64 lowercase hex characters, no colons"
    return None


def validate(doc):
    errors, warnings = [], []

    if not isinstance(doc, dict):
        return ["top level must be a JSON object"], warnings

    # --- top-level fields ---
    for field, ftype in TOP_REQUIRED.items():
        if field not in doc:
            errors.append(f"missing required field '{field}'")
        elif not isinstance(doc[field], ftype) or (ftype is int and isinstance(doc[field], bool)):
            errors.append(f"'{field}' must be of type {ftype.__name__}")
    for field, ftype in TOP_OPTIONAL.items():
        if field in doc and not isinstance(doc[field], ftype):
            errors.append(f"'{field}' must be of type {ftype.__name__}")
    for field in doc:
        if field not in TOP_REQUIRED and field not in TOP_OPTIONAL:
            errors.append(f"unknown top-level field '{field}'")

    if doc.get("contract_version") not in (None, CONTRACT_VERSION) and isinstance(doc.get("contract_version"), int):
        errors.append(f"contract_version must be {CONTRACT_VERSION}")
    tool = doc.get("tool")
    if isinstance(tool, str) and tool != tool.lower():
        errors.append("'tool' must be lowercase")
    if isinstance(doc.get("status"), str) and doc["status"] not in STATUSES:
        errors.append(f"'status' must be one of {sorted(STATUSES)}")
    if isinstance(doc.get("errors"), list) and not all(isinstance(e, str) for e in doc["errors"]):
        errors.append("'errors' must be a list of strings")

    start, end = parse_time(doc.get("started_at")), parse_time(doc.get("finished_at"))
    if "started_at" in doc and start is None:
        errors.append("'started_at' must be ISO 8601 UTC ending in Z, e.g. 2026-10-29T10:00:00Z")
    if "finished_at" in doc and end is None:
        errors.append("'finished_at' must be ISO 8601 UTC ending in Z, e.g. 2026-10-29T10:01:00Z")
    if start and end and end < start:
        errors.append("'finished_at' is before 'started_at'")

    if doc.get("status") == "failed" and not doc.get("errors"):
        warnings.append("status is 'failed' but 'errors' is empty; say what went wrong")

    # --- findings ---
    findings = doc.get("findings") if isinstance(doc.get("findings"), list) else []
    seen = set()
    for i, f in enumerate(findings):
        where = f"findings[{i}]"
        if not isinstance(f, dict):
            errors.append(f"{where}: must be an object")
            continue
        for k in f:
            if k not in FINDING_FIELDS and k != "id":
                errors.append(f"{where}: unknown field '{k}' (put extra details inside 'data')")
        if "id" in f:
            errors.append(f"{where}: do not create IDs; the server generates them")

        ntype, value = f.get("type"), f.get("value")
        if ntype not in NODE_TYPES:
            errors.append(f"{where}: type '{ntype}' is not one of {sorted(NODE_TYPES)}")
            continue
        msg = check_value(ntype, value)
        if msg:
            errors.append(f"{where}: {ntype} value {value!r} {msg}")

        key = (ntype, value, json.dumps(f.get("parent"), sort_keys=True))
        if key in seen:
            warnings.append(f"{where}: duplicate finding {ntype} {value!r} with the same parent")
        seen.add(key)

        if "severity" in f and f["severity"] not in SEVERITIES:
            errors.append(f"{where}: severity must be one of {sorted(SEVERITIES)}")
        if ntype in ("vulnerability", "secret", "leak") and "severity" not in f:
            warnings.append(f"{where}: {ntype} has no severity")
        if "data" in f and not isinstance(f["data"], dict):
            errors.append(f"{where}: 'data' must be an object")

        parent, relation = f.get("parent"), f.get("relation")
        if parent is None:
            if relation is not None:
                errors.append(f"{where}: has 'relation' but no 'parent'")
            elif ntype not in ("domain", "subdomain", "ip", "url"):
                warnings.append(f"{where}: {ntype} has no parent; it will float alone on the graph")
            continue

        if not isinstance(parent, dict) or set(parent) != {"type", "value"}:
            errors.append(f"{where}: 'parent' must be exactly {{\"type\": ..., \"value\": ...}}")
            continue
        ptype, pvalue = parent["type"], parent["value"]
        if ptype not in NODE_TYPES:
            errors.append(f"{where}: parent type '{ptype}' is not a valid node type")
            continue
        msg = check_value(ptype, pvalue)
        if msg:
            errors.append(f"{where}: parent {ptype} value {pvalue!r} {msg}")

        if relation is None:
            errors.append(f"{where}: has 'parent' but no 'relation'")
        elif relation not in RELATIONS:
            errors.append(f"{where}: relation '{relation}' is not one of {sorted(RELATIONS)}")
        else:
            ok_parents, ok_children = RELATIONS[relation]
            if ptype not in ok_parents or ntype not in ok_children:
                errors.append(
                    f"{where}: '{relation}' can't link {ptype} -> {ntype} "
                    f"(allowed: {sorted(ok_parents)} -> {sorted(ok_children)})"
                )

    if not findings and doc.get("status") == "success":
        warnings.append("no findings; fine if the tool really found nothing")

    return errors, warnings


def main(paths):
    if not paths:
        print(__doc__.strip())
        return 2
    bad = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                doc = json.load(fh)
        except (OSError, json.JSONDecodeError) as e:
            print(f"✗ {path}\n    cannot read JSON: {e}")
            bad += 1
            continue
        errors, warnings = validate(doc)
        n = len(doc.get("findings", [])) if isinstance(doc, dict) and isinstance(doc.get("findings"), list) else 0
        if errors:
            bad += 1
            print(f"✗ {path}  ({len(errors)} error(s), {n} findings)")
        else:
            print(f"✓ {path}  ({n} findings)")
        for e in errors:
            print(f"    ERROR  {e}")
        for w in warnings:
            print(f"    warn   {w}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
