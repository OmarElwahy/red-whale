"""gau command, per-provider runs and parsing, without the network. Run: python -m unittest discover -s tools/urls/gau"""

import json
import os
import subprocess
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
sys.path.insert(0, os.path.join(HERE, ".."))
import redwhale_tool as rw  # noqa: E402
import run as gau  # noqa: E402
from urls_common import STATIC_ARG  # noqa: E402

TARGET = "northwind.example"
CONFIG_WARNING = 'time="2026-11-23T21:54:22Z" level=warning msg="error reading config: Config file /tmp/.gau.toml not found, using default config"'


def section(provider, urls=(), exit_code="0", stderr=(CONFIG_WARNING,)):
    lines = [f"#provider {provider} exit={exit_code}"]
    lines += [u if u.startswith("{") or not u else json.dumps({"url": u}, separators=(",", ":")) for u in urls]
    lines += [f"#stderr {provider}", *stderr]
    return "\n".join(lines) + "\n"


def parsed(raw, target=TARGET, ttype="domain"):
    run = rw.ToolRun("gau", target)
    run.target_type = ttype
    gau.parse(raw, run, target)
    return run


def by_value(run):
    return {f["value"]: f for f in run.result()["findings"]}


class CommandTest(unittest.TestCase):
    def test_one_provider_target_host_only_static_blacklist(self):
        cmd = gau.build_command(TARGET, "wayback", 290)
        self.assertEqual(cmd[0], "/usr/local/bin/gau")
        self.assertEqual(cmd[-1], TARGET)
        self.assertEqual(cmd.count(TARGET), 1)
        self.assertEqual(cmd[cmd.index("--providers") + 1], "wayback")
        self.assertEqual(cmd[cmd.index("--blacklist") + 1], STATIC_ARG)
        self.assertEqual(cmd[cmd.index("--threads") + 1], "2")
        self.assertNotIn("--subs", cmd)
        for flag in ("--json", "--verbose"):
            self.assertIn(flag, cmd)

    def test_http_timeout_within_the_share(self):
        def http_timeout(share):
            cmd = gau.build_command(TARGET, "otx", share)
            return cmd[cmd.index("--timeout") + 1]

        self.assertEqual([http_timeout(s) for s in (290, 60, 1)], ["180", "60", "5"])

    def test_providers_need_no_keys(self):
        self.assertEqual(gau.PROVIDERS, ("wayback", "commoncrawl", "otx"))


class ParseTest(unittest.TestCase):
    def test_sources_merge_sorted_serves_from_the_target(self):
        raw = (section("wayback", ["http://northwind.example:80/", "https://northwind.example/login"])
               + section("commoncrawl", ["https://northwind.example/login"])
               + section("otx", ["http://northwind.example/", "https://northwind.example/login#top"]))
        run = parsed(raw)
        doc = run.result()
        self.assertEqual(doc["status"], "success", doc["errors"])
        found = by_value(run)
        self.assertEqual(list(found), ["http://northwind.example/", "https://northwind.example/login"])
        self.assertEqual(found["http://northwind.example/"]["data"], {"source": ["otx", "wayback"], "historical": True})
        self.assertEqual(found["https://northwind.example/login"]["data"]["source"], ["commoncrawl", "otx", "wayback"])
        for f in found.values():
            self.assertEqual(f["parent"], {"type": "domain", "value": TARGET})
            self.assertEqual(f["relation"], "serves")

    def test_subdomain_target(self):
        run = parsed(section("otx", ["https://www.northwind.example/a", "https://northwind.example/b"]),
                     target="www.northwind.example", ttype="subdomain")
        found = by_value(run)
        self.assertEqual(list(found), ["https://www.northwind.example/a"])
        self.assertEqual(found["https://www.northwind.example/a"]["parent"],
                         {"type": "subdomain", "value": "www.northwind.example"})
        self.assertEqual(run.ignored, 1)

    def test_other_hosts_and_junk_are_ignored_not_errors(self):
        raw = section("otx", [
            "https://rdap.northwind.example/rdap/domain/X.COM",   # another host (OTX answers with subdomains)
            "https://www.northwind.example/",                    # also another host: no --subs
            "https://partner.example/northwind.example",
            "https://northwind.example:99999/",                  # port out of range
            "ftp://northwind.example/",
            '{"nourl": 1}',
            '["https://northwind.example/"]',
            "",
            "https://northwind.example/ok?x=%20",
            "https://northwind.example/a b",                     # kept: a space in the path is fine (the server
        ])                                                       # percent-encodes it)
        run = parsed(raw)
        doc = run.result()
        self.assertEqual(doc["status"], "success", doc["errors"])
        self.assertEqual(list(by_value(run)), ["https://northwind.example/ok?x=%20", "https://northwind.example/a b"])
        self.assertEqual(run.ignored, 7)

    def test_failed_provider_named_others_kept(self):
        raw = (section("wayback", [], stderr=[
                   CONFIG_WARNING,
                   'time="2026-11-23T21:55:52Z" level=info msg="fetching northwind.example" page=0 provider=wayback',
                   'time="2026-11-23T21:57:22Z" level=warning msg="northwind.example - failed to fetch wayback results page 0: timeout" provider=wayback'])
               + section("commoncrawl", ["https://northwind.example/cc"], exit_code="timeout")
               + section("otx", ["https://northwind.example/otx"]))
        doc = parsed(raw).result()
        self.assertEqual(doc["status"], "partial")
        self.assertEqual(doc["errors"], [
            "wayback failed: northwind.example - failed to fetch wayback results page 0: timeout",
            "commoncrawl failed: timed out; kept its URLs so far",
        ])
        self.assertEqual([f["value"] for f in doc["findings"]], ["https://northwind.example/cc", "https://northwind.example/otx"])

    def test_exit_code_and_start_failure(self):
        raw = section("wayback", exit_code="2", stderr=["boom"]) + section("otx", exit_code="error", stderr=["No such file"])
        doc = parsed(raw).result()
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(doc["errors"], ["wayback failed: exit code 2", "otx failed: couldn't start gau: No such file"])

    def test_error_level_line_fails_the_provider(self):
        raw = section("otx", ["https://northwind.example/"], stderr=['time="x" level=error msg="otx said no"'])
        doc = parsed(raw).result()
        self.assertEqual(doc["errors"], ["otx failed: otx said no"])
        self.assertEqual(doc["status"], "partial")

    def test_not_json_line_is_an_error(self):
        raw = section("otx", ["https://northwind.example/"]).replace("#stderr", "garbage line\n#stderr")
        doc = parsed(raw).result()
        self.assertEqual(doc["errors"], ["otx: line is not JSON: garbage line"])

    def test_empty_and_unsectioned_raw(self):
        self.assertEqual(parsed("").result()["status"], "success")
        doc = parsed('{"url":"https://northwind.example/"}\n').result()
        self.assertEqual(doc["errors"], ["raw output has no '#provider' section"])

    def test_no_findings_for_other_target_types(self):
        run = parsed(section("otx", ["https://northwind.example/"]), ttype="url")
        self.assertEqual(run.result()["findings"], [])


class CapTest(unittest.TestCase):
    """The 5,000 cap, through the whole script (--replay) on a synthetic raw file."""

    def test_first_5000_after_dedupe_then_partial(self):
        with tempfile.TemporaryDirectory() as d:
            raw = os.path.join(d, "raw.txt")
            wayback = [f"https://northwind.example/p/{i}" for i in range(3000)]
            # 3000 more, 500 of them duplicates of wayback's (one spelled with :443): 5,500 distinct in all
            otx = [f"https://northwind.example:443/p/{i}" for i in range(2500, 3000)] + \
                  [f"https://northwind.example/q/{i}" for i in range(2500)]
            with open(raw, "w", encoding="utf-8", newline="\n") as fh:
                fh.write(section("wayback", wayback) + section("commoncrawl") + section("otx", otx))
            out = os.path.join(d, "out")
            code = gau.main("gau", gau.parse, fetch=gau.fetch, needs_target_type=True,
                            argv=["--target", TARGET, "--target-type", "domain", "--out", out, "--replay", raw])
            self.assertEqual(code, 0)
            with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
        self.assertEqual(doc["status"], "partial")
        self.assertEqual(doc["errors"], ["5500 URLs after deduplication; kept the first 5000"])
        values = [f["value"] for f in doc["findings"]]
        self.assertEqual(len(values), 5000)
        self.assertEqual(values[0], "https://northwind.example/p/0")
        self.assertEqual(values[2999], "https://northwind.example/p/2999")
        self.assertEqual(values[-1], "https://northwind.example/q/1999")
        dup = next(f for f in doc["findings"] if f["value"] == "https://northwind.example/p/2500")
        self.assertEqual(dup["data"]["source"], ["otx", "wayback"])


class FetchTest(unittest.TestCase):
    """fetch() with a stand-in for gau (a Python one-liner per provider): order, shares, a timeout."""

    def setUp(self):
        self.calls = []
        self.old = gau.build_command, gau.MIN_SHARE
        gau.MIN_SHARE = 1
        scripts = {
            "wayback": "import sys; print('{\"url\":\"https://northwind.example/w\"}'); print('time=x level=info msg=\"ok\"', file=sys.stderr)",
            "commoncrawl": "import sys, time; print('{\"url\":\"https://northwind.example/c\"}', flush=True); time.sleep(30)",
            "otx": "print('{\"url\":\"https://northwind.example/o\"}')",
        }

        def fake(target, provider, seconds):
            self.calls.append((provider, seconds))
            return [sys.executable, "-I", "-c", scripts[provider], target]

        gau.build_command = fake

    def tearDown(self):
        gau.build_command, gau.MIN_SHARE = self.old

    def test_one_after_another_each_with_its_share(self):
        run = rw.ToolRun("gau", TARGET)
        run.target_type = "domain"
        raw = gau.fetch(TARGET, run, 3)
        self.assertEqual([p for p, _ in self.calls], ["wayback", "commoncrawl", "otx"])
        self.assertEqual(self.calls[0][1], 1)  # 3 s over 3 providers
        self.assertGreaterEqual(self.calls[1][1], 1)  # wayback's unused time goes to the ones after it
        self.assertIn("#provider wayback exit=0\n", raw)
        self.assertIn("#provider commoncrawl exit=timeout\n", raw)
        self.assertIn("#provider otx exit=0\n", raw)
        self.assertEqual(run.command.count(" ; "), 2)
        gau.parse(raw, run, TARGET)
        doc = run.result()
        self.assertEqual(doc["status"], "partial")
        self.assertEqual(doc["errors"], ["commoncrawl failed: timed out; kept its URLs so far"])
        # commoncrawl's line printed before the timeout is kept
        self.assertEqual([f["value"] for f in doc["findings"]],
                         ["https://northwind.example/w", "https://northwind.example/c", "https://northwind.example/o"])

    def test_no_time_left_does_not_start(self):
        run = rw.ToolRun("gau", TARGET)
        run.target_type = "domain"
        raw = gau.fetch(TARGET, run, 0)
        self.assertEqual(self.calls, [("wayback", 0), ("commoncrawl", 0), ("otx", 0)])
        self.assertEqual(raw.count("exit=timeout"), 3)
        self.assertIn("not started: 0s left", raw)

    def test_refuses_other_target_types(self):
        run = rw.ToolRun("gau", "https://northwind.example/")
        run.target_type = "url"
        self.assertEqual(gau.fetch("https://northwind.example/", run, 9), "")
        self.assertEqual(self.calls, [])
        self.assertEqual(run.errors, ["gau takes a domain or subdomain, not a url; gau was not run"])


if __name__ == "__main__":
    unittest.main()
