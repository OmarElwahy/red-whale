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

    def replay_typed(self, extra):
        path = os.path.join(self.dir.name, "raw.txt")
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("x\n")
        seen = []

        def parse(raw, run, target):
            seen.append(run.target_type)
            run.add("ip", "198.18.0.10", parent=(run.target_type, target))

        code = rw.main("demo", parse, command=lambda t: ["demo", t], needs_target_type=True,
                       argv=["--target", "lab.northwind.example", *extra, "--out", self.out, "--replay", path])
        return code, seen

    def test_target_type_is_passed_to_the_parser(self):
        code, seen = self.replay_typed(["--target-type", "subdomain"])
        self.assertEqual((code, seen), (0, ["subdomain"]))
        self.assertEqual(self.result()["findings"][0]["parent"], {"type": "subdomain", "value": "lab.northwind.example"})

    def test_a_tool_that_needs_the_target_type_never_guesses_it(self):
        code, seen = self.replay_typed([])
        self.assertEqual((code, seen), (2, []))
        self.assertFalse(os.path.exists(os.path.join(self.out, "result.json")))

    def test_the_target_type_must_be_a_targetable_node_type(self):
        with self.assertRaises(SystemExit):
            self.replay_typed(["--target-type", "technology"])

    def test_tools_that_dont_need_it_still_work_without(self):
        code = self.replay('{"host":"a.example.com"}\n', lambda raw, run, target: run.add_subdomain("a.example.com", target))
        self.assertEqual(code, 0)


class TechValueTest(unittest.TestCase):
    def test_one_spelling(self):
        cases = [
            (("Nginx", "1.30.6"), "nginx/1.30.6"),
            (("nginx", "1.30.6"), "nginx/1.30.6"),
            (("Microsoft ASP.NET", "4.0"), "microsoft-asp.net/4.0"),
            (("  Apache   HTTP Server ", " 2.4.62 "), "apache-http-server/2.4.62"),
            (("PHP", None), "php"),
            (("PHP", ""), "php"),
            (("Twitter Bootstrap", "5.3.0 beta"), "twitter-bootstrap/5.3.0beta"),
            (("a/b", "1/2"), "a-b/1-2"),
            (("Go", "V1.22"), "go/v1.22"),
        ]
        for (name, version), want in cases:
            self.assertEqual(rw.tech_value(name, version), want, (name, version))

    def test_empty_name_is_empty(self):
        self.assertEqual(rw.tech_value("", "1.0"), "")
        self.assertEqual(rw.tech_value(None), "")
        self.assertEqual(rw.tech_value(" / ", "1"), "")

    def test_values_pass_the_contract(self):
        run = rw.ToolRun("demo", "example.com")
        self.assertTrue(run.add("technology", rw.tech_value("Microsoft ASP.NET", "4.0"),
                                parent=("url", "https://example.com/")))


if __name__ == "__main__":
    unittest.main()
