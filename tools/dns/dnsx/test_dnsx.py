"""dnsx command and parsing, without the network. Run: python -m unittest discover -s tools/dns/dnsx"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as dnsx  # noqa: E402

TARGET = "lab.northwind.example"


def parsed(*items, target=TARGET, ttype="subdomain"):
    run = rw.ToolRun("dnsx", target)
    run.target_type = ttype
    dnsx.parse("\n".join(json.dumps(i) for i in items), run, target)
    return run


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

    def test_one_name_three_record_types_own_resolver_never_brute_force(self):
        cmd = dnsx.build_command(TARGET)
        self.assertEqual(cmd[:3], ["/usr/local/bin/dnsx", "-l", TARGET])
        self.assertEqual(cmd.count(TARGET), 1)
        self.assertEqual(cmd[-2:], ["-r", "127.0.0.11:53"])
        for flag in ("-a", "-aaaa", "-cname", "-j", "-duc"):
            self.assertIn(flag, cmd)
        for never in ("-d", "-domain", "-w", "-wordlist", "-hf", "-ptr", "-mx", "-txt", "-ns", "-axfr"):
            self.assertNotIn(never, cmd)

    def test_a_target_dnsx_would_read_as_a_file_or_a_list_is_refused(self):
        with self.assertRaisesRegex(ValueError, "as a file or a list"):
            dnsx.build_command("a.example,b.example")
        with self.assertRaisesRegex(ValueError, "as a file or a list"):
            dnsx.build_command(rw.RESOLV_CONF)  # an existing path

    def test_a_refused_target_never_runs_and_says_why(self):
        out = os.path.join(self.dir.name, "out")
        code = rw.main("dnsx", dnsx.parse, command=dnsx.build_command, needs_target_type=True, needs_resolvers=True,
                       argv=["--target", "a.example,b.example", "--target-type", "subdomain", "--out", out])
        self.assertEqual(code, 0)
        with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
            doc = json.load(fh)
        self.assertEqual((doc["status"], doc["command"]), ("failed", ""))
        self.assertIn("dnsx -l would read it as a file or a list", doc["errors"][0])


class ParseTest(unittest.TestCase):
    def test_a_and_aaaa_resolve_from_the_target_typed_by_the_server(self):
        run = parsed({"host": "Example.COM.", "a": ["198.18.0.1"], "aaaa": ["2001:db8::1"]}, target="example.com",
                     ttype="domain")
        self.assertEqual(run.result()["findings"], [
            {"type": "ip", "value": "198.18.0.1", "parent": {"type": "domain", "value": "example.com"},
             "relation": "resolves_to"},
            {"type": "ip", "value": "2001:db8::1", "parent": {"type": "domain", "value": "example.com"},
             "relation": "resolves_to"},
        ])

    def test_the_target_is_never_a_finding(self):
        run = parsed({"host": TARGET, "a": ["198.18.0.10"], "cname": ["edge.northwind.example"]})
        self.assertEqual([f["type"] for f in run.result()["findings"]], ["ip"])

    def test_one_cname_is_a_string_a_chain_is_a_list_in_order(self):
        one = parsed({"host": TARGET, "a": ["198.18.0.10"], "cname": ["Edge.Northwind.Example."]})
        self.assertEqual(one.result()["findings"][0]["data"], {"cname": "edge.northwind.example"})
        chain = parsed({"host": TARGET, "a": ["198.18.0.10"], "cname": ["b.cdn.example", "a.cdn.example"]})
        self.assertEqual(chain.result()["findings"][0]["data"], {"cname": ["b.cdn.example", "a.cdn.example"]})

    def test_a_dangling_cname_is_no_finding_and_no_error(self):
        run = parsed({"host": TARGET, "cname": ["gone.northwind.example"], "status_code": "NOERROR"})
        doc = run.result()
        self.assertEqual((doc["findings"], doc["errors"], doc["status"]), ([], [], "success"))

    def test_no_answer_is_no_finding(self):
        self.assertEqual(parsed({"host": TARGET, "status_code": "NXDOMAIN"}).result()["findings"], [])

    def test_an_answer_for_another_name_is_an_error(self):
        run = parsed({"host": "other.example", "a": ["198.18.0.99"]}, {"host": TARGET, "a": ["198.18.0.10"]})
        doc = run.result()
        self.assertEqual([f["value"] for f in doc["findings"]], ["198.18.0.10"])
        self.assertEqual(doc["status"], "partial")
        self.assertIn("answer for another name: other.example", doc["errors"][0])


if __name__ == "__main__":
    unittest.main()
