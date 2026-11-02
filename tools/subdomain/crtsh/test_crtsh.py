"""crt.sh retries and parsing, without the network. Run: python -m unittest discover -s tools/subdomain/crtsh"""

import io
import json
import os
import sys
import unittest
import urllib.error

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as crtsh  # noqa: E402


class Clock:
    """A fake clock that sleep() moves forward."""

    def __init__(self):
        self.t = 0.0
        self.slept = []

    def now(self):
        return self.t

    def sleep(self, s):
        self.slept.append(s)
        self.t += s


class Answer(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def opener_of(*outcomes, clock=None, cost=0):
    """Each call takes `cost` seconds and returns (bytes) or raises (exception) the next outcome."""
    calls = []

    def opener(req, timeout):
        calls.append((req.full_url, timeout))
        if clock:
            clock.t += min(cost, timeout)  # a real request gives up at its timeout
        out = outcomes[len(calls) - 1]
        if isinstance(out, Exception):
            raise out
        return Answer(out)

    return opener, calls


def http(code):
    return urllib.error.HTTPError("https://crt.sh/", code, "x", {}, None)


class FetchTest(unittest.TestCase):
    def setUp(self):
        self.run = rw.ToolRun("crtsh", "example.com")
        self.clock = Clock()

    def fetch(self, opener, timeout=390):
        return crtsh.fetch("example.com", self.run, timeout, opener=opener, sleep=self.clock.sleep, clock=self.clock.now)

    def test_first_answer_is_used(self):
        opener, calls = opener_of(b"[]")
        self.assertEqual(self.fetch(opener), "[]")
        self.assertEqual(calls[0][0], "https://crt.sh/?q=%25.example.com&output=json")
        self.assertEqual(self.run.command, "GET https://crt.sh/?q=%25.example.com&output=json")
        self.assertEqual(self.run.errors, [])

    def test_timeouts_502_and_html_are_retried_with_backoff(self):
        opener, calls = opener_of(TimeoutError("timed out"), b"<html>busy</html>", b'[{"id": 1}]')
        self.assertEqual(self.fetch(opener), '[{"id": 1}]')
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.clock.slept, [5, 15])
        opener, calls = opener_of(http(502), b"[]")
        self.assertEqual(self.fetch(opener), "[]")

    def test_gives_up_after_three_tries_with_the_reason(self):
        opener, calls = opener_of(http(503), http(503), http(503))
        self.assertEqual(self.fetch(opener), "")
        self.assertEqual(len(calls), 3)
        self.assertEqual(self.run.errors, ["crt.sh gave no usable answer (HTTP 503)"])

    def test_a_client_error_is_not_retried(self):
        opener, calls = opener_of(http(404))
        self.assertEqual(self.fetch(opener), "")
        self.assertEqual(len(calls), 1)

    def test_stays_inside_the_time_it_was_given(self):
        opener, calls = opener_of(TimeoutError("t"), TimeoutError("t"), TimeoutError("t"), clock=self.clock, cost=60)
        self.fetch(opener, timeout=100)
        # try 1 takes 60 s; after a 5 s wait try 2 only gets the 35 s left; no time for a third
        self.assertEqual([t for _, t in calls], [90, 35])
        self.assertLessEqual(self.clock.t, 100)
        self.assertIn("TimeoutError", self.run.errors[0])


class ParseTest(unittest.TestCase):
    def test_names_from_every_certificate_counted_once_each(self):
        certs = [
            {"id": 1, "common_name": "a.example.com", "name_value": "a.example.com\n*.a.example.com\nB.example.com",
             "not_before": "2025-01-02T00:00:00"},
            {"id": 2, "common_name": "Example.com, Inc.", "name_value": "a.example.com\nexample.com",
             "not_before": "2026-03-04T00:00:00"},
        ]
        run = rw.ToolRun("crtsh", "example.com")
        crtsh.parse(json.dumps(certs), run, "example.com")
        doc = run.result()
        self.assertEqual(doc["errors"], [])
        got = {f["value"]: f["data"] for f in doc["findings"]}
        self.assertEqual(got, {
            "a.example.com": {"certificates": 2, "first_cert": "2025-01-02", "last_cert": "2026-03-04"},
            "b.example.com": {"certificates": 1, "first_cert": "2025-01-02", "last_cert": "2025-01-02"},
        })
        self.assertEqual(run.ignored, 3)  # the wildcard, the apex, the organization name

    def test_no_answer_and_not_a_list(self):
        run = rw.ToolRun("crtsh", "example.com")
        crtsh.parse("", run, "example.com")
        crtsh.parse('{"error": "x"}', run, "example.com")
        self.assertEqual(run.errors, ["expected a JSON array of certificates, got dict"])


if __name__ == "__main__":
    unittest.main()
