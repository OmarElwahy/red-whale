#!/usr/bin/env python3
"""
crt.sh (certificate transparency search) -> RED WHALE contract v1 (docs/contract.md).

    python run.py --target example.com --out out/
    python run.py --target northwind.example --out out/ --replay fixtures/raw.json

There is no program to run: crt.sh is an HTTP API, so this script uses main(..., fetch=fetch) instead of a command.
crt.sh is slow and often fails (timeouts, 502/503, an HTML error page instead of JSON), so fetch() retries with
backoff and stays inside the time the runner gives the script.
"""

import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
from redwhale_tool import clean_host, log, main  # noqa: E402

TOOL = "crtsh"
TRIES = 3
BACKOFF_SECONDS = [5, 15, 45]   # wait before try 2, try 3
PER_TRY_SECONDS = 90            # one request's timeout (crt.sh can take a minute for a big domain)
RETRY_HTTP = {429, 500, 502, 503, 504}


def query_url(target):
    # %.example.com = every name under example.com (crt.sh's LIKE syntax); output=json = machine-readable
    return "https://crt.sh/?" + urllib.parse.urlencode({"q": "%." + target, "output": "json"})


def fetch(target, run, timeout, opener=urllib.request.urlopen, sleep=time.sleep, clock=time.monotonic):
    """The JSON text crt.sh returned ('' if every try failed; the failures are in run.errors)."""
    url = query_url(target)
    run.command = f"GET {url}"
    deadline = clock() + timeout
    problem = "no try fitted in the time left"
    for attempt in range(1, TRIES + 1):
        left = deadline - clock()
        if left < 5:
            break
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "redwhale-crtsh/1", "Accept": "application/json"})
            with opener(req, timeout=min(PER_TRY_SECONDS, left)) as resp:
                body = resp.read().decode("utf-8", "replace")
            json.loads(body)  # crt.sh sometimes answers 200 with an HTML error page
            if attempt > 1:
                log(f"crt.sh answered on try {attempt}")
            return body
        except urllib.error.HTTPError as e:
            problem = f"HTTP {e.code}"
            if e.code not in RETRY_HTTP:
                break
        except json.JSONDecodeError:
            problem = "the answer was not JSON (crt.sh is probably overloaded)"
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            problem = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
        log(f"crt.sh try {attempt} failed: {problem}")
        if attempt < TRIES:
            wait = BACKOFF_SECONDS[attempt - 1]
            if clock() + wait + 5 >= deadline:
                break
            sleep(wait)
    run.error(f"crt.sh gave no usable answer ({problem})")
    return ""


def parse(raw, run, target):
    # A JSON array of certificates: {"id", "issuer_name", "common_name", "name_value" (names, one per line),
    # "not_before", "not_after", "serial_number", ...}. One finding per name, with how many certificates had it.
    if not raw.strip():
        return
    certs = json.loads(raw)
    if not isinstance(certs, list):
        run.error(f"expected a JSON array of certificates, got {type(certs).__name__}")
        return
    seen = {}  # cleaned name -> data
    for cert in certs:
        if not isinstance(cert, dict):
            continue
        names = set()
        for field in ("common_name", "name_value"):
            value = cert.get(field)
            if isinstance(value, str):
                names.update(n.strip() for n in value.split("\n") if n.strip())
        issued = str(cert.get("not_before", ""))[:10]
        for name in names:
            key = clean_host(name)
            d = seen.setdefault(key, {"name": name, "certificates": 0, "first_cert": issued, "last_cert": issued})
            d["certificates"] += 1
            if issued:
                d["first_cert"] = min(filter(None, [d["first_cert"], issued]))
                d["last_cert"] = max(d["last_cert"], issued)
    for d in seen.values():
        run.add_subdomain(d["name"], target, data={k: d[k] for k in ("certificates", "first_cert", "last_cert") if d[k]})


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, fetch=fetch))
