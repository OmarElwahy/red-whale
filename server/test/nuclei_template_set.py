"""
The nuclei template set, checked inside the vuln image with no network (server/test/nuclei.e2e.test.ts pipes this to
`python3 -I -` in the image). It lists the templates run.py's own command loads (-tl) and reads each one, so a
template update that brings in something run.py must exclude fails the e2e instead of reaching a target.

Prints one JSON object; every list in it must be empty.
"""

import json
import re
import subprocess
import sys

sys.path.insert(0, "/opt/redwhale/vuln/nuclei")
import run  # noqa: E402

ROOT = "/opt/nuclei-templates/"
out = subprocess.run(run.build_command("https://lab.redwhale.test/") + ["-tl"], capture_output=True, text=True).stdout
files = [l.strip() if l.strip().startswith("/") else ROOT + l.strip() for l in out.splitlines()
         if l.strip().endswith(".yaml")]

SIDE_PORT = re.compile(r"\{\{(?:Hostname|Host)\}\}:\d+")
ITEM = re.compile(r"""^\s*-\s*["']?(.*?)["']?\s*$""")
REQUEST_LINE = re.compile(r"^\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|PROPFIND|TRACE|CONNECT)\s+(\S+)", re.I)
TARGET_URL = re.compile(r"https?://\{\{(?:Hostname|Host|FQDN|RDN|DN)\}\}", re.I)
ANNOTATED_HOST = re.compile(r"^\s*@Host:\s*(\S+)", re.I)


def outside_hosts(text):
    """Where a template connects other than the input URL: an `@Host:` annotation in a raw request (it moves the
    connection), a literal http(s)://<host> in a `path:` list or a raw request line. The info section (references)
    is skipped; a host only named in a header or a parameter is not a connection."""
    parts = re.split(r"^(?:http|requests):\s*$", text, maxsplit=1, flags=re.M)
    if len(parts) < 2:
        return []
    found, in_path, path_indent = [], False, -1
    for line in parts[1].splitlines():
        stripped = line.strip()
        indent = len(line) - len(line.lstrip())
        if re.match(r"^\s*path:\s*$", line):
            in_path, path_indent = True, indent
            continue
        if in_path:
            if stripped.startswith("-") and indent >= path_indent:
                value = ITEM.match(line).group(1)
                if re.match(r"https?://", value, re.I) and not TARGET_URL.match(value):
                    found.append(value)
                continue
            if stripped and indent <= path_indent:
                in_path = False
        m = REQUEST_LINE.match(line)
        if m and re.match(r"https?://", m.group(1), re.I) and not TARGET_URL.match(m.group(1)):
            found.append(m.group(1))
        a = ANNOTATED_HOST.match(line)
        if a and not a.group(1).startswith("{{"):
            found.append("@Host: " + a.group(1))
    return found


with_excluded_tag, side_port, outside, loaded_ids = [], [], {}, set()
for f in files:
    text = open(f, encoding="utf-8", errors="replace").read()
    tid = (re.search(r"^id:\s*(\S+)", text, re.M) or [None, f])[1]
    loaded_ids.add(tid)
    tags = re.search(r"^  tags:\s*(.+)$", text, re.M)
    if {t.strip().lower() for t in (tags.group(1) if tags else "").split(",")} & set(run.EXCLUDED_TAGS):
        with_excluded_tag.append(tid)
    if SIDE_PORT.search(text):
        side_port.append(tid)
    hosts = outside_hosts(text)
    if hosts:
        outside[tid] = hosts[:3]

ignore = [l.strip()[2:] for l in open("/opt/nuclei-config/.nuclei-ignore") if l.strip().startswith("- http/")]
print(json.dumps({
    "count": len(files),
    "excludedTags": list(run.EXCLUDED_TAGS),
    "excludedIds": list(run.EXCLUDED_IDS),
    "withExcludedTag": with_excluded_tag,
    "excludedIdLoaded": sorted(set(run.EXCLUDED_IDS) & loaded_ids),
    "sidePort": side_port,
    "outsideHost": outside,
    "notHttp": [f for f in files if not f.startswith(ROOT + "http/")],
    "ignoreListed": len(ignore),
    "ignoredButLoaded": [f for f in ignore if ROOT + f in files],
}))
