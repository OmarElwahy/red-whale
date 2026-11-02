"""Unit tests for the tool helper. Run: python -m unittest discover -s tools -p "test_*.py" (pnpm test runs them)."""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import redwhale_tool as rw  # noqa: E402


class AddTest(unittest.TestCase):
    def setUp(self):
        self.run = rw.ToolRun("demo", "example.com")

    def test_subdomains_are_cleaned_and_deduplicated(self):
        self.assertTrue(self.run.add_subdomain(" API.Example.com. ", "example.com", data={"source": "a"}))
        self.assertTrue(self.run.add_subdomain("api.example.com", "Example.COM", data={"source": "b"}))
        [f] = self.run.result()["findings"]
        self.assertEqual(f["value"], "api.example.com")
        self.assertEqual(f["parent"], {"type": "domain", "value": "example.com"})
        self.assertEqual(f["relation"], "has_subdomain")
        self.assertEqual(f["data"], {"source": ["a", "b"]})

    def test_wildcards_the_apex_and_other_domains_are_ignored_not_errors(self):
        for host in ["*.example.com", "*.dev.example.com", "example.com", "example.com.evil.org", "notexample.com", ""]:
            self.assertFalse(self.run.add_subdomain(host, "example.com"), host)
        doc = self.run.result()
        self.assertEqual(doc["findings"], [])
        self.assertEqual(doc["errors"], [])
        self.assertEqual(self.run.ignored, 6)

    def test_non_ascii_becomes_punycode(self):
        self.run.add_subdomain("bücher.example.com", "example.com")
        self.assertEqual(self.run.result()["findings"][0]["value"], "xn--bcher-kva.example.com")

    def test_invalid_values_are_skipped_and_reported(self):
        self.assertFalse(self.run.add_subdomain("bad_host!.example.com", "example.com"))
        doc = self.run.result()
        self.assertEqual(doc["status"], "failed")
        self.assertIn("skipped 1 finding", doc["errors"][0])

    def test_relation_is_inferred_or_refused(self):
        self.assertTrue(self.run.add("ip", "203.0.113.5", parent=("subdomain", "a.example.com")))
        self.assertEqual(self.run.result()["findings"][0]["relation"], "resolves_to")
        self.assertFalse(self.run.add("leak", "x", parent=("ip", "203.0.113.5")))

    def test_status(self):
        self.assertEqual(self.run.result()["status"], "success")
        self.run.error("rate limited")
        self.assertEqual(self.run.result()["status"], "failed")
        self.run.add_subdomain("a.example.com", "example.com")
        self.assertEqual(self.run.result()["status"], "partial")


class SafeTargetTest(unittest.TestCase):
    def test_option_like_targets_are_refused(self):
        for bad in ["-d", "--help", "", "a b", "a\nb", "a\x00b"]:
            with self.assertRaises(ValueError, msg=bad):
                rw.safe_target(bad)
        self.assertEqual(rw.safe_target("example.com"), "example.com")


class MainTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.out = os.path.join(self.dir.name, "out")

    def tearDown(self):
        self.dir.cleanup()

    def replay(self, raw, parse, target="example.com"):
        path = os.path.join(self.dir.name, "raw.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(raw)
        code = rw.main("demo", parse, command=lambda t: ["demo", "-d", t],
                       argv=["--target", target, "--out", self.out, "--replay", path])
        return code

    def result(self):
        with open(os.path.join(self.out, "result.json"), encoding="utf-8") as fh:
            return json.load(fh)

    def test_replay_writes_raw_and_a_valid_result(self):
        def parse(raw, run, target):
            for item in rw.json_lines(raw, run):
                run.add_subdomain(item["host"], target)

        code = self.replay('{"host":"a.example.com"}\nnot json\n\n{"host":"*.example.com"}\n', parse)
        self.assertEqual(code, 0)
        doc = self.result()
        self.assertEqual(doc["command"], "demo -d example.com")
        self.assertEqual([f["value"] for f in doc["findings"]], ["a.example.com"])
        self.assertEqual(doc["status"], "partial")
        self.assertIn("line 2 is not JSON", doc["errors"][0])
        with open(os.path.join(self.out, "raw.txt"), encoding="utf-8") as fh:
            self.assertIn("not json", fh.read())

    def test_a_parser_crash_still_writes_a_valid_failed_result(self):
        def parse(raw, run, target):
            raise KeyError("host")

        self.assertEqual(self.replay("x", parse), 0)
        doc = self.result()
        self.assertEqual(doc["status"], "failed")
        self.assertIn("parser crashed: KeyError", doc["errors"][0])

    def test_an_option_like_target_is_refused_before_anything_runs(self):
        never = lambda t: self.fail("the tool must not run")  # noqa: E731
        # "--target=-oX" gets past argparse: safe_target refuses it.
        self.assertEqual(rw.main("demo", lambda *a: None, command=never, argv=["--target=-oX", "--out", self.out]), 2)
        # "--target -oX": argparse itself refuses it (it looks like an option).
        with self.assertRaises(SystemExit):
            rw.main("demo", lambda *a: None, command=never, argv=["--target", "-oX", "--out", self.out])
        self.assertFalse(os.path.exists(self.out))

    def test_raw_output_is_capped_with_a_note(self):
        old = rw.RAW_CAP_BYTES
        rw.RAW_CAP_BYTES = 10
        try:
            self.replay("x" * 50, lambda *a: None)
        finally:
            rw.RAW_CAP_BYTES = old
        with open(os.path.join(self.out, "raw.txt"), encoding="utf-8") as fh:
            text = fh.read()
        self.assertTrue(text.startswith("x" * 10 + "\n[RED WHALE: raw output truncated at 10 of 50 bytes]"))

    def test_a_missing_program_is_an_error_not_a_crash(self):
        run = rw.ToolRun("demo", "example.com")
        self.assertEqual(run.run_command(["redwhale-no-such-program-xyz"]), "")
        self.assertIn("not found", run.errors[0])


if __name__ == "__main__":
    unittest.main()
