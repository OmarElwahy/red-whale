#!/usr/bin/env python3
"""
gau (getallurls) -> RED WHALE contract v1 (docs/contract.md). PASSIVE: it asks web archives about the target, never
the target itself.

    python run.py --target northwind.example --target-type domain --out out/ --replay fixtures/raw.txt
    python run.py --target <a domain you may research> --target-type domain --out out/        runs gau

gau runs once per provider (wayback, then commoncrawl, then otx), one after another, each with its share of the time
left: its JSON output names no provider, so that is the only way to say which archive had a URL. Findings:
    target --serves--> url        data {"source": [providers, sorted], "historical": true}
The target's node type comes from --target-type (domain or subdomain); it is never guessed. Only URLs on exactly the
target's host are kept (no --subs; OTX also answers with other hosts, which are ignored). URLs are deduplicated as
the server spells them, and at most MAX_URLS are kept (the first ones, in provider order); more is an error.

gau exits 0 even when a provider fails: it only logs a warning (with --verbose). A provider that times out, exits
non-zero or logs a warning/error is named in an error (status partial); the other providers' URLs are kept.

Raw output (raw.txt), one section per provider, gau's own lines unchanged:
    #provider wayback exit=0              exit=<code>, exit=timeout or exit=error (gau couldn't be started)
    {"url":"https://northwind.example/"}  gau's stdout
    #stderr wayback
    time="…" level=warning msg="…"        gau's stderr (its --verbose log)
"""

import json
import re
import shlex
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from redwhale_tool import contract, log, main  # noqa: E402
from urls_common import STATIC_ARG, canonical_url  # noqa: E402

TOOL = "gau"
GAU = "/usr/local/bin/gau"  # absolute: never whatever else is called gau on PATH
VERSION_COMMAND = [GAU, "--version"]
PROVIDERS = ("wayback", "commoncrawl", "otx")  # no API keys needed (urlscan needs one: not used)
TARGET_TYPES = ("domain", "subdomain")
MAX_URLS = 5000
HTTP_TIMEOUT_MAX = 180  # gau's own per-request timeout, at most this (and at most the provider's share)
MIN_SHARE = 5  # seconds; with less left, a provider is not started

SECTION_RE = re.compile(r"^#provider (\S+) exit=(\S+)$")
STDERR_RE = re.compile(r"^#stderr (\S+)$")
LEVEL_RE = re.compile(r'\blevel=(warning|error|fatal|panic)\b')
MSG_RE = re.compile(r'\bmsg="((?:[^"\\]|\\.)*)"')


def build_command(target, provider, seconds):
    # Flags checked against `gau --help` of v2.2.4 (docs/phase-6c5-progress.md has the final argv).
    #   --providers <one>          one archive per run, so each URL's source is known
    #   (no --subs)                the target host only
    #   --blacklist <static>       no images, fonts, audio, video (urls_common.STATIC_EXTENSIONS)
    #   --threads 2                gentle on the archives
    #   --json                     one {"url": …} per line
    #   --verbose                  gau logs a provider's failure only as a warning, and only with --verbose
    #   --timeout N --retries 1    gau's own per-request limit, within the provider's share
    http_timeout = max(5, min(HTTP_TIMEOUT_MAX, int(seconds)))
    return [GAU, "--providers", provider, "--threads", "2", "--blacklist", STATIC_ARG, "--json", "--verbose",
            "--timeout", str(http_timeout), "--retries", "1", target]


def _text(out):
    return out.decode("utf-8", "replace") if isinstance(out, bytes) else (out or "")


def fetch(target, run, timeout):
    """Run gau once per provider, one after another; returns the sectioned raw output (module docstring)."""
    if run.target_type not in TARGET_TYPES:
        run.error(f"gau takes a domain or subdomain, not a {run.target_type}; gau was not run")
        run.command = f"gau {target} (refused)"
        return ""
    deadline = time.monotonic() + timeout
    commands, sections = [], []
    for i, provider in enumerate(PROVIDERS):
        share = max(0, round((deadline - time.monotonic()) / (len(PROVIDERS) - i)))
        cmd = build_command(target, provider, share)
        commands.append(shlex.join(cmd))
        out = err = ""
        if share < MIN_SHARE:
            code = "timeout"
            err = f"not started: {share}s left of the time budget"
        else:
            log(f"[run] {shlex.join(cmd)}  (at most {share}s)")
            try:
                proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace",
                                      timeout=share, stdin=subprocess.DEVNULL)
                code, out, err = str(proc.returncode), proc.stdout, proc.stderr
            except subprocess.TimeoutExpired as e:
                code, out, err = "timeout", _text(e.stdout), _text(e.stderr)
            except OSError as e:
                code, err = "error", str(e)
        if err.strip():
            log(err.rstrip()[-2000:])
        sections.append(f"#provider {provider} exit={code}\n{out.rstrip(chr(10))}\n#stderr {provider}\n"
                        f"{err.rstrip(chr(10))}\n")
    run.command = " ; ".join(commands)
    return "".join(sections)


def _sections(raw):
    """[(provider, exit, stdout lines, stderr lines)] from the raw output."""
    out, current, stream = [], None, None
    for line in raw.splitlines():
        m = SECTION_RE.match(line)
        if m:
            current = (m.group(1), m.group(2), [], [])
            out.append(current)
            stream = current[2]
            continue
        m = STDERR_RE.match(line)
        if m and current is not None and m.group(1) == current[0]:
            stream = current[3]
            continue
        if stream is not None:
            stream.append(line)
    return out


def _failure(exit_code, stderr):
    """Why this provider's results are incomplete, or None."""
    if exit_code == "timeout":
        return "timed out; kept its URLs so far"
    if exit_code == "error":
        return f"couldn't start gau: {' '.join(stderr)[:200]}"
    if exit_code != "0":
        return f"exit code {exit_code}"
    for line in stderr:
        if LEVEL_RE.search(line) and "error reading config" not in line:  # no config file is expected (no keys)
            m = MSG_RE.search(line)
            return (m.group(1) if m else line)[:200]
    return None


def parse(raw, run, target):
    ttype = run.target_type
    if ttype not in TARGET_TYPES:
        return  # fetch() already said why
    sections = _sections(raw)
    if raw.strip() and not sections:
        run.error("raw output has no '#provider' section")
        return

    sources = {}  # url -> set of providers, in first-seen order
    for provider, exit_code, stdout, stderr in sections:
        if provider not in PROVIDERS:
            run.error(f"unknown provider section '{provider}'")
            continue
        why = _failure(exit_code, stderr)
        if why:
            run.error(f"{provider} failed: {why}")
        for line in stdout:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except ValueError:
                run.error(f"{provider}: line is not JSON: {line[:100]}")
                continue
            got = canonical_url(item.get("url")) if isinstance(item, dict) else None
            if got is None or got[1] != target or contract.check_value("url", got[0]):
                run.ignored += 1  # another host, or an archived string that isn't a usable URL
                continue
            sources.setdefault(got[0], set()).add(provider)

    urls = list(sources)
    if len(urls) > MAX_URLS:
        run.error(f"{len(urls)} URLs after deduplication; kept the first {MAX_URLS}")
        urls = urls[:MAX_URLS]
    for url in urls:
        run.add("url", url, parent=(ttype, target), relation="serves",
                data={"source": sorted(sources[url]), "historical": True})


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, fetch=fetch, version_command=VERSION_COMMAND, needs_target_type=True))
