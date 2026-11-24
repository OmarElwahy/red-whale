#!/usr/bin/env python3
"""
nuclei -> RED WHALE contract v1 (docs/contract.md). ACTIVE: nuclei sends HTTP requests to the target itself.

    python run.py --target https://lab.northwind.example/ --out out/ --replay fixtures/raw.jsonl
    python run.py --target <a URL you may scan> --out out/          runs nuclei
    python run.py ... --template-ids git-config,laravel-env         tests only: fewer templates (never in tool.json)

The target is a url node. nuclei runs the pinned templates baked into the image (/opt/nuclei-templates, HTTP only)
with the tags below, never the excluded ones, against exactly that URL: no out-of-band callbacks (-ni), no redirects
followed (-dr), no update check or download (-duc), at most 5 requests a second. Findings:
    url --has_url--> url                     the URL a template matched at, when it isn't the target itself (and has
                                             no "."/".." segments: those hang off the target, see has_dot_segments)
    url --uses_technology--> technology      a `tech` template's result (not a WAF's): nginx/1.30.6, php/8.3.12, ...
    url --has_vulnerability--> vulnerability everything else: the template's CVE ID if it has one, else its template ID
One finding per value and URL: a template matching with several matchers is one finding, data.matcher a sorted list.
nuclei's severity is kept (unknown -> info). Extracted values are masked in vulnerability findings (they can be
credentials or tokens); raw.txt keeps nuclei's own output unchanged (the evidence, local only).
A result on another host is ignored. The scan is `partial` when nuclei skips the host as unresponsive or stops at its
time limit (-mt): it says so only on stderr, so the script runs nuclei without -silent and reads that.
"""

import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import canonical_url, json_lines, main, mask_secret, resolvers, tech_value  # noqa: E402

TOOL = "nuclei"
NUCLEI = "/usr/local/bin/nuclei"  # absolute: never whatever else is called nuclei on PATH
VERSION_COMMAND = [NUCLEI, "-version"]
TEMPLATES = "/opt/nuclei-templates/http/"
TAGS = ("cve", "misconfig", "exposure", "tech", "takeover")
# intrusive..osint: the phase's rule. ssrf, oast, proxy: templates that make the TARGET fetch a hard-coded outside
# host (oast.pro, interact.sh, 169.254.169.254, ...) which -ni doesn't exclude (docs/phase-6c6-progress.md).
EXCLUDED_TAGS = ("intrusive", "dos", "fuzz", "bruteforce", "default-login", "osint", "ssrf", "oast", "proxy")
# nuclei stops itself after this long, well inside tool.json's timeoutSec (3600; the script gets 3570), and keeps
# what it found: the job is then `partial`, not killed.
MAX_TIME = "55m"
RESOLVER_FILE = "redwhale-nuclei-resolvers.txt"  # nuclei's -r takes only a file

SEVERITIES = ("info", "low", "medium", "high", "critical")
TEMPLATE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$")
MAX_TEMPLATE_IDS = 20
CVE_ID = re.compile(r"^CVE-\d{4}-\d{4,}$", re.IGNORECASE)
VERSION = re.compile(r"^v?(\d+(?:\.\d+)+[0-9A-Za-z.+_-]*)$")
NAME_VERSION = re.compile(r"^([A-Za-z][A-Za-z0-9 ._+-]*)/v?(\d+(?:\.\d+)*[0-9A-Za-z.+_-]*)$")
TECH_SUFFIXES = ("-version-detect", "-detection", "-detect", "-version", "-fingerprint")
NOT_TECH_TAGS = ("waf",)  # waf-detect is tagged tech, but "nginxgeneric" is a WAF rule set, not a technology
GENERIC_MATCHERS = ("version", "header", "headers", "body", "status", "word", "regex", "detect", "default")
MAX_EXTRACTED, MAX_EXTRACTED_LEN = 5, 100
MAX_REFERENCES, MAX_REFERENCE_LEN = 5, 300
MAX_TAGS = 20


def resolver_file():
    """The machine's own resolvers, one per line, in a temp file (nuclei's -r reads only a file). None if none."""
    found = resolvers()
    if not found:
        return None
    path = os.path.join(tempfile.gettempdir(), RESOLVER_FILE)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("\n".join(found) + "\n")
    return path


def scan_url(target):
    """The target without a trailing "/" (unless it has a query): templates that append a path from a payload
    ({{BaseURL}}{{paths}}, e.g. laravel-env's "/.env") would otherwise request "https://host//.env"."""
    if target.endswith("/") and "?" not in target and "#" not in target:
        return target.rstrip("/")
    return target


def build_command(target, template_ids=()):
    # Flags checked against `nuclei -h` of v3.11.1 (docs/phase-6c6-progress.md has the probes behind each one).
    #   -u target -t <http templates> -pt http     only the baked HTTP templates, against that one URL (without
    #                                              its trailing "/": scan_url)
    #   -tags ... -etags ...                       the phase's tags, never the excluded ones (plus the templates'
    #                                              own .nuclei-ignore, read from /opt/nuclei-config)
    #   -ni -dr -duc                               no interactsh/OAST, never follow a redirect, no update check
    #   -rl 5 -c 5 -retries 1 -timeout 10          at most 5 requests a second
    #   -mt 55m                                    nuclei ends the scan itself before the job's time limit
    #   -jsonl -or -ot -nc                         JSON lines without raw requests/responses or encoded templates
    #   -r <file>                                  DNS only through the machine's resolver (main refuses without one)
    #   (no -silent)                               stderr says when a host was skipped or the time ran out
    #   -id <ids>                                  tests only (--template-ids): narrows, never widens: nuclei ANDs it
    #                                              with the tag filters
    if canonical_url(target) is None:
        raise ValueError(f"nuclei scans an http(s) URL, not '{target}'")
    cmd = [NUCLEI, "-u", scan_url(target), "-t", TEMPLATES, "-pt", "http",
           "-tags", ",".join(TAGS), "-etags", ",".join(EXCLUDED_TAGS),
           "-ni", "-dr", "-duc",
           "-rl", "5", "-c", "5", "-retries", "1", "-timeout", "10", "-mt", MAX_TIME,
           "-jsonl", "-or", "-ot", "-nc"]
    path = resolver_file()
    if path:
        cmd += ["-r", path]
    if template_ids:
        cmd += ["-id", ",".join(template_ids)]
    return cmd


def split_template_ids(argv):
    """(template ids, the other arguments) from argv: --template-ids a,b or --template-ids=a,b (tests only)."""
    ids, rest = [], []
    i = 0
    while i < len(argv):
        arg = argv[i]
        if arg == "--template-ids" or arg.startswith("--template-ids="):
            value = arg.split("=", 1)[1] if "=" in arg else (argv[i + 1] if i + 1 < len(argv) else "")
            i += 1 if "=" in arg else 2
            for t in (v.strip() for v in value.split(",")):
                if not TEMPLATE_ID.match(t):
                    raise ValueError(f"--template-ids: '{t}' is not a template ID")
                ids.append(t)
            continue
        rest.append(arg)
        i += 1
    if len(ids) > MAX_TEMPLATE_IDS:
        raise ValueError(f"--template-ids: at most {MAX_TEMPLATE_IDS}")
    return ids, rest


# ---------------------------------------------------------------- parsing

def _strings(value):
    if value is None:
        return []
    items = value if isinstance(value, list) else [value]
    return [str(v).strip() for v in items if v is not None and str(v).strip()]


def _tags(info):
    tags = info.get("tags")
    if isinstance(tags, str):
        tags = tags.split(",")
    return [t.lower() for t in _strings(tags)]


def severity_of(info):
    s = str(info.get("severity") or "").strip().lower()
    return s if s in SEVERITIES else "info"


def cve_ids(info):
    classification = info.get("classification") if isinstance(info.get("classification"), dict) else {}
    return sorted({c.upper() for c in _strings(classification.get("cve-id")) if CVE_ID.match(c)})


def is_technology(info):
    tags = _tags(info)
    return "tech" in tags and not any(t in tags for t in NOT_TECH_TAGS) and not cve_ids(info)


def technology_of(template_id, matcher, extracted):
    """The technology value of a tech template's result, or "" if it names none."""
    for e in extracted:
        m = NAME_VERSION.match(e)
        if m:
            return tech_value(m.group(1), m.group(2))
    version = next((VERSION.match(e).group(1) for e in extracted if VERSION.match(e)), None)
    if matcher and matcher.lower() not in GENERIC_MATCHERS:
        name = matcher
    else:
        name = template_id
        for suffix in TECH_SUFFIXES:
            if name.endswith(suffix):
                name = name[: -len(suffix)]
                break
    return tech_value(name, version)


def has_dot_segments(url):
    """True for a path with "." or ".." segments, also written %2e (path traversal templates). The server stores a
    URL as the WHATWG parser spells it, which resolves them ("/cgi-bin/.%2e/.%2e/etc/passwd" -> "/etc/passwd"): a
    url node that misleads. Such a match hangs off the target instead; data.matched_at keeps what was requested."""
    path = urlsplit(url).path
    return any(seg in (".", "..") for seg in re.sub(r"%2e", ".", path, flags=re.IGNORECASE).split("/"))


def check_log(stderr, run):
    """nuclei's stderr (not with --replay): an incomplete scan is an error, so the job is `partial`."""
    if stderr is None:
        return
    for host in sorted(set(re.findall(r"Skipped (\S+) from target list as found unresponsive", stderr))):
        run.error(f"nuclei skipped {host} as unresponsive (too many errors): the scan is incomplete")
    if "CTRL+C pressed" in stderr:
        run.error(f"nuclei stopped at its time limit (-mt {MAX_TIME}) before the scan finished; kept what it found")
    elif "Scan completed" not in stderr and not run.errors:
        run.error("nuclei did not report that the scan completed")
    loaded = re.search(r"Templates loaded for current scan: (\d+)", stderr)
    if loaded and int(loaded.group(1)) == 0:
        run.error("nuclei loaded no templates")


def parse(raw, run, target):
    # A line (abridged):
    # {"template-id":"git-config","info":{"name":"Git Configuration - Detect","tags":["config","git","exposure"],
    #  "severity":"medium","classification":{"cve-id":null,"cvss-score":5.3},"reference":null},
    #  "matcher-name":"…","type":"http","host":"https://host/","matched-at":"https://host/.git/config",
    #  "extracted-results":["user:pass"],"timestamp":"…","matcher-status":true}
    seed = canonical_url(target)
    if seed is None:
        run.error(f"target '{target}' is not an http(s) URL")
        return
    seed_url, host = seed
    groups = {}  # (type, value, url) -> what goes into one finding

    for item in json_lines(raw, run):
        if not isinstance(item, dict) or not item.get("template-id"):
            run.error(f"line without a template-id: {str(item)[:100]}")
            continue
        template_id = str(item["template-id"])
        info = item.get("info") if isinstance(item.get("info"), dict) else {}
        matched_raw = str(item.get("matched-at") or item.get("url") or item.get("host") or "")
        matched = canonical_url(matched_raw)
        if matched is not None and matched[1] != host:
            run.ignored += 1  # another host: out of scope (-dr keeps nuclei on the target; this is the second check)
            continue
        url = matched[0] if matched and not has_dot_segments(matched[0]) else seed_url
        matcher = str(item["matcher-name"]).strip() if item.get("matcher-name") else None
        extracted = _strings(item.get("extracted-results"))[:MAX_EXTRACTED]

        if is_technology(info):
            value = technology_of(template_id, matcher, extracted)
            if not value:
                run.ignored += 1
                continue
            key = ("technology", value, url)
            g = groups.setdefault(key, {"templates": set(), "matchers": set(), "extracted": set()})
            g["templates"].add(template_id)
            if matcher:
                g["matchers"].add(matcher)
            g["extracted"].update(e[:MAX_EXTRACTED_LEN] for e in extracted)
            continue

        cves = cve_ids(info)
        value = cves[0] if cves else template_id
        key = ("vulnerability", value, url)
        g = groups.setdefault(key, {"templates": set(), "matchers": set(), "extracted": set(), "names": set(),
                                    "matched_at": set(), "cves": set(cves), "tags": set(), "references": set(),
                                    "cvss": set(), "severity": "info"})
        g["templates"].add(template_id)
        if info.get("name"):
            g["names"].add(str(info["name"]))
        g["matched_at"].add(matched_raw if matched is None else matched[0])
        if matcher:
            g["matchers"].add(matcher)
        g["extracted"].update(mask_secret(e) for e in extracted)
        g["tags"].update(_tags(info))
        g["references"].update(r[:MAX_REFERENCE_LEN] for r in _strings(info.get("reference")))
        classification = info.get("classification") if isinstance(info.get("classification"), dict) else {}
        if isinstance(classification.get("cvss-score"), (int, float)):
            g["cvss"].add(classification["cvss-score"])
        sev = severity_of(info)
        if SEVERITIES.index(sev) > SEVERITIES.index(g["severity"]):
            g["severity"] = sev

    # A bare technology name (tech-detect's "nginx") is dropped when the same URL has it with a version.
    versioned = {(url, value.split("/", 1)[0]) for (t, value, url) in groups if t == "technology" and "/" in value}
    added_urls = set()
    for (ntype, value, url), g in groups.items():
        if ntype == "technology" and "/" not in value and (url, value) in versioned:
            continue
        parent = ("url", url)
        if url != seed_url and url not in added_urls:
            # the URL the template matched at, under the target (the url -> url relation katana uses)
            run.add("url", url, parent=("url", seed_url), relation="has_url", data={"source": "nuclei"})
            added_urls.add(url)
        if ntype == "technology":
            data = {"template": _one_or_list(g["templates"])}
            if g["matchers"]:
                data["matcher"] = sorted(g["matchers"])
            if g["extracted"]:
                data["extracted"] = sorted(g["extracted"])[:MAX_EXTRACTED]
            run.add("technology", value, parent=parent, relation="uses_technology", data=data)
            continue
        data = {"template": _one_or_list(g["templates"]), "name": _one_or_list(g["names"]),
                "matched_at": _one_or_list(g["matched_at"])}
        if g["matchers"]:
            data["matcher"] = sorted(g["matchers"])
        if g["extracted"]:
            data["extracted"] = sorted(g["extracted"])[:MAX_EXTRACTED]
        if len(g["cves"]) > 1:
            data["cves"] = sorted(g["cves"])
        if g["cvss"]:
            data["cvss"] = max(g["cvss"])
        if g["references"]:
            data["references"] = sorted(g["references"])[:MAX_REFERENCES]
        if g["tags"]:
            data["tags"] = sorted(g["tags"])[:MAX_TAGS]
        run.add("vulnerability", value, parent=parent, relation="has_vulnerability", severity=g["severity"],
                data={k: v for k, v in data.items() if v not in (None, "", [])})

    check_log(run.stderr, run)


def _one_or_list(values):
    values = sorted(values)
    return values[0] if len(values) == 1 else values


def cli(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    try:
        template_ids, rest = split_template_ids(argv)
    except ValueError as e:
        print(f"✗ {e}", file=sys.stderr)
        return 2
    return main(TOOL, parse, command=lambda t: build_command(t, template_ids), version_command=VERSION_COMMAND,
                needs_resolvers=True, argv=rest)


if __name__ == "__main__":
    sys.exit(cli())
