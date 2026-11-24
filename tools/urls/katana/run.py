#!/usr/bin/env python3
"""
katana -> RED WHALE contract v1 (docs/contract.md). ACTIVE: it crawls the target itself.

    python run.py --target https://lab.northwind.example/ --out out/ --replay fixtures/raw.jsonl
    python run.py --target <a URL you may crawl> --out out/        runs katana

The target is a url node. katana fetches it, then the pages, scripts and other files it links to, on exactly that
URL's host (-fs fqdn), two levels deep, GET only, never following a redirect. Findings:
    the target url                                  (katana fetched it: data status_code)
    page --has_url--> url                           each URL under the page it was found on (katana's "source")
Status code, where it was found (tag/attribute, e.g. "a"/"href", "js"/"regex") and a redirect's Location go in the
url's data. A URL katana found but didn't fetch (deeper than -d) has no status_code. A URL on any other host is
ignored (katana's scope already keeps them out; this is the second check).
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from redwhale_tool import json_lines, main, resolver_args  # noqa: E402
from urls_common import STATIC_ARG, canonical_url  # noqa: E402

TOOL = "katana"
KATANA = "/usr/local/bin/katana"  # absolute: never whatever else is called katana on PATH
VERSION_COMMAND = [KATANA, "-version"]
# The crawl stops itself after this long, well inside tool.json's timeoutSec (300; the script gets 270): katana then
# prints what it has and exits, instead of being killed.
CRAWL_SECONDS = 210


def build_command(target):
    # Flags checked against `katana -h` of v1.8.0 (docs/phase-6c5-progress.md has the probes behind each one).
    #   -u target -fs fqdn -dr          that URL's exact host only; never follow a redirect (it is reported, with its
    #                                   Location, and not fetched)
    #   -d 2 -jc                        two levels deep; endpoints named in JavaScript files too
    #   -ndef -ef <static>              katana's own extension denylist off (it drops PDFs); ours instead: no images,
    #                                   fonts, audio, video (urls_common.STATIC_EXTENSIONS), so they aren't requested
    #   (no -kf)                        v1.8.0's sitemap handling loses the pages it lists; robots.txt adds nothing
    #   -rl 5 -c 2 -p 1                 at most 5 requests a second, 2 at a time
    #   -ct 210s -timeout 10 -retry 1   the crawl ends itself before the job's time limit
    #   -j -or -eof body                JSON lines without raw requests/responses or bodies (-ob would also turn off
    #                                   the JavaScript parsing)
    #   -silent -nc -duc                output only, no colors, no update check (no extra call)
    #   -r <own resolvers>              DNS only through the machine's resolver; with none, main(needs_resolvers=True)
    #                                   refuses to run katana at all
    if canonical_url(target) is None:
        raise ValueError(f"katana crawls an http(s) URL, not '{target}'")
    return [KATANA, "-u", target, "-fs", "fqdn", "-dr", "-d", "2", "-jc", "-ndef", "-ef", STATIC_ARG,
            "-rl", "5", "-c", "2", "-p", "1", "-ct", f"{CRAWL_SECONDS}s", "-timeout", "10", "-retry", "1",
            "-j", "-or", "-eof", "body", "-silent", "-nc", "-duc",
            *resolver_args()]


def _header(headers, name):
    for k, v in (headers or {}).items() if isinstance(headers, dict) else ():
        if str(k).lower() == name:
            return v
    return None


def parse(raw, run, target):
    # A line:
    # {"timestamp":"…","request":{"method":"GET","endpoint":"https://host/about.html","tag":"a","attribute":"href",
    #  "source":"https://host/"},"response":{"status_code":200,"headers":{…},"content_length":196}}
    seed = canonical_url(target)
    if seed is None:
        run.error(f"target '{target}' is not an http(s) URL")
        return
    seed_url, host = seed
    for item in json_lines(raw, run):
        request = item.get("request") if isinstance(item, dict) else None
        if not isinstance(request, dict):
            run.error(f"line without a request: {str(item)[:100]}")
            continue
        found = canonical_url(request.get("endpoint"))
        if found is None or found[1] != host:
            run.ignored += 1  # another host (out of scope) or not an http(s) URL
            continue
        url = found[0]

        data = {}
        response = item.get("response")
        if isinstance(response, dict) and response.get("status_code") is not None:
            data["status_code"] = response["status_code"]
            location = _header(response.get("headers"), "location")
            if location and 300 <= int(response["status_code"]) < 400:
                data["location"] = str(location)
        for key in ("tag", "attribute"):
            if request.get(key):
                data[key] = str(request[key])
        if item.get("error"):
            data["error"] = str(item["error"])[:200]

        source = canonical_url(request.get("source")) if request.get("source") else None
        if url == seed_url and source is None:
            run.add("url", url, data=data)  # the target itself
            continue
        parent = source[0] if source and source[1] == host and source[0] != url else seed_url
        if parent == url:
            run.add("url", url, data=data)  # a link back to the target from itself
            continue
        run.add("url", url, parent=("url", parent), relation="has_url", data=data)


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND, needs_resolvers=True))
