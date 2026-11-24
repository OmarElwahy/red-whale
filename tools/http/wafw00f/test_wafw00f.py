"""wafw00f command and parsing, without the network. Run: python -m unittest discover -s tools/http/wafw00f"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as wafw00f  # noqa: E402

TARGET = "https://lab.northwind.example/waf/"
FIXTURES = os.path.join(HERE, "fixtures")
DOWN_STDERR = (
    "ERROR:wafw00f:Something went wrong HTTPSConnectionPool(host='lab.northwind.example', port=443): Max retries "
    "exceeded with url: / (Caused by NameResolutionError(\"Failed to resolve 'lab.northwind.example'\"))\n"
    "ERROR:wafw00f:Site lab.northwind.example appears to be down\n"
)


def record(detected=True, firewall="Shadow Daemon", manufacturer="Zecure", url=TARGET):
    return {"detected": detected, "firewall": firewall, "manufacturer": manufacturer,
            "trigger_url": f"{url}?abc=%3Cscript%3E" if detected else None, "url": url}


def parsed(raw, target=TARGET, stderr=None):
    run = rw.ToolRun("wafw00f", target)
    run.stderr = stderr
    if not isinstance(raw, str):
        raw = json.dumps(raw)
    wafw00f.parse(raw, run, target)
    return run


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return fh.read()


class Command(unittest.TestCase):
    def test_argv(self):
        cmd = wafw00f.build_command(TARGET)
        self.assertEqual(cmd, ["/opt/wafw00f/bin/wafw00f", "-r", "-o", "-", "-f", "json", "--no-colors", "-T", "10",
                               TARGET])

    def test_never_all_signatures_proxy_or_extra_targets(self):
        cmd = wafw00f.build_command(TARGET)
        for flag in ("-a", "--findall", "-p", "--proxy", "-i", "--input-file", "-H", "--headers", "-t", "--test",
                     "-v", "-l", "--list"):
            self.assertNotIn(flag, cmd)
        self.assertEqual(cmd.count(TARGET), 1)
        self.assertEqual(cmd[-1], TARGET)

    def test_refuses_non_http_targets(self):
        for bad in ("lab.northwind.example", "ftp://lab.northwind.example/", "198.18.0.10:443/tcp"):
            with self.assertRaises(ValueError):
                wafw00f.build_command(bad)

    def test_tool_json(self):
        with open(os.path.join(HERE, "tool.json"), encoding="utf-8") as fh:
            spec = json.load(fh)
        self.assertEqual(spec["accepts"], ["url"])
        self.assertEqual(spec["mode"], "active")
        self.assertEqual(spec["external"], [])
        self.assertIn("redirects are not followed", spec["contacts"])
        self.assertIn("attack-looking", spec["contacts"])
        self.assertEqual(spec["argv"][:3], ["python3", "-I", "/opt/redwhale/http/wafw00f/run.py"])


class Parse(unittest.TestCase):
    def test_lab_waf_fixture(self):
        run = parsed(fixture("raw.json"))
        self.assertEqual(run.errors, [])
        self.assertEqual(run.result()["findings"], [{
            "type": "technology", "value": "shadow-daemon",
            "parent": {"type": "url", "value": TARGET}, "relation": "uses_technology",
            "data": {"waf": True, "manufacturer": "Zecure"},
        }])

    def test_lab_without_waf_is_success_with_no_findings(self):
        run = parsed(fixture("no-waf.json"), target="https://lab.northwind.example/")
        doc = run.result()
        self.assertEqual((doc["status"], doc["errors"], doc["findings"]), ("success", [], []))

    def test_generic_detection_is_weak_evidence(self):
        run = parsed([record(firewall="Generic", manufacturer="Unknown")])
        self.assertEqual(run.errors, [])
        (f,) = run.result()["findings"]
        self.assertEqual((f["type"], f["value"], f["relation"]), ("technology", "generic-waf", "uses_technology"))
        self.assertEqual(f["data"], {"waf": True, "manufacturer": None, "generic": True})

    def test_name_spelled_by_tech_value(self):
        run = parsed([record(firewall="Cloudflare", manufacturer="Cloudflare Inc.")])
        (f,) = run.result()["findings"]
        self.assertEqual(f["value"], "cloudflare")  # merges with httpx's / nuclei's cloudflare
        self.assertEqual(f["data"], {"waf": True, "manufacturer": "Cloudflare Inc."})
        run = parsed([record(firewall="AWS Elastic Load Balancer", manufacturer="Amazon")])
        self.assertEqual(run.result()["findings"][0]["value"], "aws-elastic-load-balancer")

    def test_unknown_manufacturer_is_null(self):
        run = parsed([record(firewall="SomeWAF", manufacturer="Unknown")])
        self.assertEqual(run.result()["findings"][0]["data"], {"waf": True, "manufacturer": None})

    def test_target_url_compared_canonically(self):
        run = parsed([record(url="HTTPS://Lab.Northwind.Example:443/waf/")])
        self.assertEqual(run.errors, [])
        self.assertEqual(len(run.result()["findings"]), 1)

    def test_record_for_another_url_is_ignored(self):
        run = parsed([record(url="https://elsewhere.northwind.example/")])
        doc = run.result()
        self.assertEqual(doc["findings"], [])
        self.assertEqual(doc["status"], "failed")
        self.assertIn("another URL", doc["errors"][0])

    def test_site_down_fails_with_the_reason(self):
        run = parsed("[]", stderr=DOWN_STDERR)
        doc = run.result()
        self.assertEqual(doc["status"], "failed")
        self.assertIn("lab.northwind.example appears to be down", doc["errors"][0])
        self.assertIn("NameResolutionError", doc["errors"][0])

    def test_site_down_on_replay_has_no_stderr(self):
        doc = parsed("[]").result()
        self.assertEqual(doc["status"], "failed")
        self.assertIn("appears to be down", doc["errors"][0])

    def test_bad_output(self):
        for raw, msg in (("", "printed nothing"), ("not json", "not JSON"), ('{"a": 1}', "not a list"),
                         ("[1]", "not an object")):
            doc = parsed(raw).result()
            self.assertEqual(doc["status"], "failed", raw)
            self.assertIn(msg, doc["errors"][0], raw)

    def test_detected_without_a_name_is_an_error(self):
        doc = parsed([record(firewall="None")]).result()
        self.assertEqual(doc["status"], "failed")
        self.assertIn("without a WAF name", doc["errors"][0])


if __name__ == "__main__":
    unittest.main()
