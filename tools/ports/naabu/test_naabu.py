"""naabu command and parsing, without the network. Run: python -m unittest discover -s tools/ports/naabu"""

import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as naabu  # noqa: E402


def parsed(*items, target="198.18.0.10"):
    run = rw.ToolRun("naabu", target)
    naabu.parse("\n".join(json.dumps(i) for i in items), run, target)
    return run


class CommandTest(unittest.TestCase):
    def test_one_ip_connect_scan_top_100_rate_limited_no_raw_packets(self):
        cmd = naabu.build_command("198.18.0.10")
        self.assertEqual(cmd[:3], ["/usr/local/bin/naabu", "-host", "198.18.0.10"])
        pairs = dict(zip(cmd[3::], cmd[4::]))
        self.assertEqual((pairs["-s"], pairs["-tp"], pairs["-rate"], pairs["-c"]), ("c", "100", "50", "10"))
        for flag in ("-Pn", "-j", "-silent", "-nc", "-duc", "-no-stdin"):
            self.assertIn(flag, cmd)
        # never: SYN scans, host discovery probes, other hosts' DNS, nmap, uploads, passive lookups
        for never in ("-wn", "-sn", "-pe", "-arp", "-sa", "-nmap", "-nmap-cli", "-pd", "-dashboard", "-passive", "-sV"):
            self.assertNotIn(never, cmd)

    def test_ipv6_is_passed_canonical(self):
        self.assertEqual(naabu.build_command("2001:DB8::0010")[2], "2001:db8::10")

    def test_anything_but_one_ip_is_refused_and_never_runs(self):
        for bad in ("lab.northwind.example", "198.18.0.10,198.18.0.11", "198.18.0.0/28"):
            with self.assertRaisesRegex(ValueError, "only against one IP", msg=bad):
                naabu.build_command(bad)
        with tempfile.TemporaryDirectory() as d:
            out = os.path.join(d, "out")
            code = rw.main("naabu", naabu.parse, command=naabu.build_command,
                           argv=["--target", "lab.northwind.example", "--out", out])
            self.assertEqual(code, 0)
            with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
            self.assertEqual((doc["status"], doc["command"]), ("failed", ""))


class ParseTest(unittest.TestCase):
    def test_open_ports_hang_off_the_ip_with_the_protocol_in_data(self):
        run = parsed({"ip": "198.18.0.10", "port": 8080, "protocol": "tcp", "tls": False})
        self.assertEqual(run.result()["findings"], [
            {"type": "port", "value": "198.18.0.10:8080/tcp", "parent": {"type": "ip", "value": "198.18.0.10"},
             "relation": "has_port", "data": {"protocol": "tcp"}},
        ])

    def test_ipv6_ports_are_bracketed(self):
        run = parsed({"ip": "2001:db8::10", "port": 443, "protocol": "tcp"}, target="2001:db8::10")
        self.assertEqual(run.result()["findings"][0]["value"], "[2001:db8::10]:443/tcp")

    def test_bad_lines_and_other_addresses_are_errors(self):
        run = parsed({"ip": "198.18.0.10", "port": "x"}, {"ip": "198.18.0.99", "port": 22, "protocol": "tcp"},
                     {"ip": "198.18.0.10", "port": 22, "protocol": "tcp"})
        doc = run.result()
        self.assertEqual([f["value"] for f in doc["findings"]], ["198.18.0.10:22/tcp"])
        self.assertEqual(doc["status"], "partial")
        self.assertIn("line without an ip/port/protocol", doc["errors"][0])
        self.assertIn("open port on another address", doc["errors"][1])


if __name__ == "__main__":
    unittest.main()
