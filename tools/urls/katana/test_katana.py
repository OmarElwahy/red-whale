"""katana command and parsing, without the network. Run: python -m unittest discover -s tools/urls/katana"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
sys.path.insert(0, os.path.join(HERE, ".."))
import redwhale_tool as rw  # noqa: E402
import run as katana  # noqa: E402
from urls_common import STATIC_ARG  # noqa: E402

TARGET = "https://lab.northwind.example/"
BASE = "https://lab.northwind.example"


def line(endpoint, source=None, tag=None, attribute=None, status=200, headers=None, error=None):
    request = {"method": "GET", "endpoint": endpoint}
    if tag:
        request["tag"] = tag
    if attribute:
        request["attribute"] = attribute
    if source:
        request["source"] = source
    item = {"timestamp": "2026-11-24T10:00:00Z", "request": request}
    if status is not None:
        item["response"] = {"status_code": status, "headers": headers or {"Server": "nginx/1.30.6"}, "content_length": 1}
    if error:
        item["error"] = error
    return json.dumps(item)


def parsed(*lines, target=TARGET):
    run = rw.ToolRun("katana", target)
    katana.parse("\n".join(lines), run, target)
    return run


def findings(run):
    return [(f["value"], f.get("parent", {}).get("value"), f.get("relation"), f.get("data")) for f in run.result()["findings"]]


class CommandTest(unittest.TestCase):
    def setUp(self):
        self.old = rw.RESOLV_CONF
        self.dir = tempfile.TemporaryDirectory()
        rw.RESOLV_CONF = os.path.join(self.dir.name, "resolv.conf")
        with open(rw.RESOLV_CONF, "w", encoding="utf-8") as fh:
            fh.write("nameserver 127.0.0.11\n")

    def tearDown(self):
        rw.RESOLV_CONF = self.old
        self.dir.cleanup()

    def arg(self, cmd, flag):
        return cmd[cmd.index(flag) + 1]

    def test_same_host_no_redirects_gentle_own_resolver(self):
        cmd = katana.build_command(TARGET)
        self.assertEqual(cmd[:3], ["/usr/local/bin/katana", "-u", TARGET])
        self.assertEqual(cmd.count(TARGET), 1)
        self.assertEqual(self.arg(cmd, "-fs"), "fqdn")
        self.assertIn("-dr", cmd)
        self.assertEqual(self.arg(cmd, "-d"), "2")
        self.assertEqual(self.arg(cmd, "-rl"), "5")
        self.assertEqual(self.arg(cmd, "-ef"), STATIC_ARG)
        for flag in ("-jc", "-ndef", "-j", "-or", "-silent", "-nc", "-duc"):
            self.assertIn(flag, cmd)
        self.assertEqual(self.arg(cmd, "-eof"), "body")
        self.assertEqual(cmd[-2:], ["-r", "127.0.0.11:53"])

    def test_never_headless_forms_known_files_or_out_of_scope(self):
        cmd = katana.build_command(TARGET)
        for flag in ("-hl", "-headless", "-aff", "-automatic-form-fill", "-kf", "-known-files", "-ob", "-ns",
                     "-no-scope", "-do", "-cs", "-H"):
            self.assertNotIn(flag, cmd)

    def test_crawl_ends_before_the_job_limit(self):
        with open(os.path.join(HERE, "tool.json"), encoding="utf-8") as fh:
            timeout_sec = json.load(fh)["timeoutSec"]
        self.assertEqual(self.arg(katana.build_command(TARGET), "-ct"), f"{katana.CRAWL_SECONDS}s")
        # the script gets timeoutSec - 30 (server/src/runner/spec.ts SCRIPT_TIMEOUT_MARGIN_SEC); leave a minute more
        self.assertLessEqual(katana.CRAWL_SECONDS, timeout_sec - 30 - 60)

    def test_refuses_what_is_not_a_url(self):
        for bad in ("lab.northwind.example", "ftp://lab.northwind.example/"):
            with self.assertRaises(ValueError):
                katana.build_command(bad)


class ParseTest(unittest.TestCase):
    def test_target_then_each_url_under_its_page(self):
        run = parsed(
            line(TARGET),
            line(f"{BASE}/static/app.js", TARGET, "script", "src"),
            line(f"{BASE}/about.html", TARGET, "a", "href"),
            line(f"{BASE}/api/v1/orders", f"{BASE}/static/app.js", "js", "regex"),
            line(f"{BASE}/deep.html", f"{BASE}/item.html", "a", "href", status=None),
        )
        self.assertEqual(run.result()["status"], "success")
        self.assertEqual(findings(run), [
            (TARGET, None, None, {"status_code": 200}),
            (f"{BASE}/static/app.js", TARGET, "has_url", {"status_code": 200, "tag": "script", "attribute": "src"}),
            (f"{BASE}/about.html", TARGET, "has_url", {"status_code": 200, "tag": "a", "attribute": "href"}),
            (f"{BASE}/api/v1/orders", f"{BASE}/static/app.js", "has_url",
             {"status_code": 200, "tag": "js", "attribute": "regex"}),
            (f"{BASE}/deep.html", f"{BASE}/item.html", "has_url", {"tag": "a", "attribute": "href"}),
        ])

    def test_redirect_reported_with_location_not_followed(self):
        run = parsed(line("http://lab.northwind.example/", TARGET, "a", "href", status=301,
                          headers={"Location": "https://elsewhere.northwind.example/", "Server": "nginx"}))
        self.assertEqual(findings(run), [("http://lab.northwind.example/", TARGET, "has_url",
                                          {"status_code": 301, "location": "https://elsewhere.northwind.example/",
                                           "tag": "a", "attribute": "href"})])

    def test_other_hosts_ignored(self):
        run = parsed(line("https://elsewhere.northwind.example/partners.html", TARGET, "a", "href"),
                     line("https://northwind.example/", TARGET, "a", "href"),
                     line("mailto:x@northwind.example", TARGET, "a", "href"))
        self.assertEqual(run.result()["findings"], [])
        self.assertEqual(run.ignored, 3)
        self.assertEqual(run.result()["status"], "success")

    def test_other_port_same_host_is_kept(self):
        run = parsed(line("https://lab.northwind.example:8443/x", TARGET, "a", "href"))
        self.assertEqual(findings(run)[0][:2], ("https://lab.northwind.example:8443/x", TARGET))

    def test_server_spelling_and_fragment(self):
        run = parsed(line("https://LAB.northwind.example:443/a#top", "https://lab.northwind.example:443/", "a", "href"))
        self.assertEqual(findings(run)[0][:2], (f"{BASE}/a", TARGET))

    def test_missing_or_other_host_source_hangs_off_the_target(self):
        run = parsed(line(f"{BASE}/x", None, "a", "href"),
                     line(f"{BASE}/y", "https://elsewhere.northwind.example/", "a", "href"))
        self.assertEqual([(v, p) for v, p, _, _ in findings(run)], [(f"{BASE}/x", TARGET), (f"{BASE}/y", TARGET)])

    def test_self_link_of_the_target_is_the_target(self):
        run = parsed(line(TARGET, TARGET, "a", "href"))
        self.assertEqual(findings(run), [(TARGET, None, None, {"status_code": 200, "tag": "a", "attribute": "href"})])

    def test_target_with_a_path(self):
        target = f"{BASE}/shop/"
        run = parsed(line(target), line(f"{BASE}/shop/a.html", target, "a", "href"), target=target)
        self.assertEqual([(v, p) for v, p, _, _ in findings(run)], [(target, None), (f"{BASE}/shop/a.html", target)])

    def test_request_error_kept_as_data(self):
        run = parsed(line(f"{BASE}/slow", TARGET, "a", "href", status=None, error="context deadline exceeded"))
        self.assertEqual(findings(run)[0][3], {"tag": "a", "attribute": "href", "error": "context deadline exceeded"})

    def test_bad_lines(self):
        doc = parsed("not json", json.dumps({"timestamp": "x"}), "").result()
        self.assertEqual(doc["errors"], ["line 1 is not JSON: not json", "line without a request: {'timestamp': 'x'}"])
        self.assertEqual(doc["status"], "failed")

    def test_bad_target(self):
        doc = parsed(line(TARGET), target="lab.northwind.example").result()
        self.assertEqual(doc["errors"], ["target 'lab.northwind.example' is not an http(s) URL"])


if __name__ == "__main__":
    unittest.main()
