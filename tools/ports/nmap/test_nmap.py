"""nmap command and XML parsing, without the network. Run: python -m unittest discover -s tools/ports/nmap"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as nmap  # noqa: E402

COMMON = ["/usr/bin/nmap", "-sT", "-Pn", "-n"]
TAIL = ["-sV", "--unprivileged", "--noninteractive",
        "--max-rate", "50", "--max-retries", "1", "--host-timeout", "480s"]


def xml(ports="", host_attrs="", addr="198.18.0.10", exit_="success"):
    """A small nmaprun document shaped like nmap 7.95's (fixtures/raw.xml is a real one)."""
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE nmaprun>
<nmaprun scanner="nmap" args="/usr/bin/nmap -sT -oX - {addr}" version="7.95" xmloutputversion="1.05">
<host{host_attrs}><status state="up" reason="user-set" reason_ttl="0"/>
<address addr="{addr}" addrtype="{'ipv6' if ':' in addr else 'ipv4'}"/>
<ports>{ports}</ports>
</host>
<runstats><finished time="1794404246" elapsed="1.00" exit="{exit_}"/><hosts up="1" down="0" total="1"/></runstats>
</nmaprun>
"""


def parsed(raw, target="198.18.0.10", target_type="ip"):
    run = rw.ToolRun("nmap", target)
    run.target_type = target_type
    nmap.parse(raw, run, target)
    return run


class CommandTest(unittest.TestCase):
    def test_ip_target_scans_its_top_100_ports(self):
        self.assertEqual(nmap.build_command("198.18.0.10", "ip"),
                         [*COMMON, *TAIL, "--top-ports", "100", "-oX", "-", "198.18.0.10"])

    def test_ipv4_port_target_scans_only_that_port(self):
        self.assertEqual(nmap.build_command("198.18.0.10:22/tcp", "port"),
                         [*COMMON, *TAIL, "-p", "22", "-oX", "-", "198.18.0.10"])

    def test_ipv6_port_target_is_bracketed_and_scanned_with_dash_6(self):
        self.assertEqual(nmap.build_command("[2001:db8::10]:443/tcp", "port"),
                         [*COMMON, "-6", *TAIL, "-p", "443", "-oX", "-", "2001:db8::10"])

    def test_ipv6_ip_target(self):
        self.assertEqual(nmap.build_command("2001:db8::10", "ip"),
                         [*COMMON, "-6", *TAIL, "--top-ports", "100", "-oX", "-", "2001:db8::10"])

    def test_no_scripts_os_detection_or_udp_ever(self):
        for target, ttype in (("198.18.0.10", "ip"), ("2001:db8::10", "ip"),
                              ("198.18.0.10:22/tcp", "port"), ("[2001:db8::10]:22/tcp", "port")):
            cmd = nmap.build_command(target, ttype)
            for arg in cmd:
                self.assertNotIn(arg, ("-sC", "-O", "-A", "-sU"), msg=cmd)
                self.assertFalse(arg.startswith("--script"), msg=cmd)  # --script, --script=…, --script-args
                self.assertFalse(arg.startswith("-sC") or arg.startswith("-sU") or arg.startswith("-O"), msg=cmd)
            self.assertEqual(cmd.count("-oX"), 1)  # XML to stdout, no other output file
            self.assertFalse({"-oN", "-oG", "-oA", "-oS"} & set(cmd))
        self.assertEqual(nmap.FORBIDDEN, ("-sC", "--script", "-O", "-A", "-sU"))

    def test_a_value_that_doesnt_fit_its_type_is_refused(self):
        cases = [
            ("198.18.0.10:22/tcp", "ip"),          # a port given as an ip
            ("198.18.0.10", "port"),               # an ip given as a port
            ("198.18.0.10:22/udp", "port"),        # UDP is out of scope
            ("2001:db8::10:22/tcp", "port"),       # IPv6 without brackets
            ("[198.18.0.10]:22/tcp", "port"),      # IPv4 with brackets
            ("198.18.0.10:0/tcp", "port"),
            ("198.18.0.10:70000/tcp", "port"),
            ("198.18.0.10:ssh/tcp", "port"),
            ("lab.northwind.example:22/tcp", "port"),
            ("lab.northwind.example", "ip"),
            ("198.18.0.0/28", "ip"),
            ("lab.northwind.example", "subdomain"),
        ]
        for target, ttype in cases:
            with self.assertRaisesRegex(ValueError, "^refusing target", msg=(target, ttype)):
                nmap.build_command(target, ttype)

    def test_a_refused_target_never_runs_nmap(self):
        with tempfile.TemporaryDirectory() as d:
            code = rw.main("nmap", nmap.parse, command=nmap.build_command, needs_target_type=True,
                           argv=["--target", "198.18.0.10", "--target-type", "port", "--out", d])
            with open(os.path.join(d, "result.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
        self.assertEqual(code, 0)
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(len(doc["errors"]), 1)
        self.assertIn("a port target must be ip:port/tcp", doc["errors"][0])  # not "'/usr/bin/nmap' not found"
        self.assertEqual(doc["findings"], [])


class ParseTest(unittest.TestCase):
    def test_open_port_with_service_and_technology(self):
        run = parsed(xml('<port protocol="tcp" portid="443"><state state="open" reason="syn-ack"/>'
                         '<service name="http" product="nginx" version="1.30.6" tunnel="ssl" method="probed" conf="10">'
                         '<cpe>cpe:/a:igor_sysoev:nginx:1.30.6</cpe></service></port>'))
        self.assertEqual(run.errors, [])
        self.assertEqual(run.result()["findings"], [
            {"type": "port", "value": "198.18.0.10:443/tcp", "parent": {"type": "ip", "value": "198.18.0.10"},
             "relation": "has_port",
             "data": {"protocol": "tcp", "service": "http", "product": "nginx", "version": "1.30.6", "tunnel": "ssl"}},
            {"type": "technology", "value": "nginx/1.30.6", "parent": {"type": "port", "value": "198.18.0.10:443/tcp"},
             "relation": "uses_technology"},
        ])

    def test_no_open_ports_is_success_with_no_findings(self):
        run = parsed(xml('<extraports state="closed" count="98"/>'
                         '<port protocol="tcp" portid="22"><state state="closed" reason="conn-refused"/>'
                         '<service name="ssh" method="table" conf="3"/></port>'
                         '<port protocol="tcp" portid="25"><state state="filtered" reason="no-response"/>'
                         '<service name="smtp" method="table" conf="3"/></port>'))
        self.assertEqual((run.errors, run.result()["findings"], run.result()["status"]), ([], [], "success"))

    def test_a_closed_port_target_is_success_with_no_findings(self):
        run = parsed(xml('<port protocol="tcp" portid="22"><state state="closed" reason="conn-refused"/></port>'),
                     target="198.18.0.10:22/tcp", target_type="port")
        self.assertEqual((run.errors, run.result()["findings"], run.result()["status"]), ([], [], "success"))

    def test_a_service_guessed_from_the_port_number_is_not_reported(self):
        run = parsed(xml('<port protocol="tcp" portid="8080"><state state="open" reason="syn-ack"/>'
                         '<service name="http-proxy" method="table" conf="3"/></port>'))
        finding = run.result()["findings"]
        self.assertEqual(len(finding), 1)  # the port, no technology
        self.assertEqual(finding[0]["data"], {"protocol": "tcp"})

    def test_ipv6_port_value(self):
        run = parsed(xml('<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/>'
                         '<service name="ssh" product="OpenSSH" version="9.6p1" method="probed" conf="10"/></port>',
                         addr="2001:db8::10"),
                     target="[2001:db8::10]:22/tcp", target_type="port")
        self.assertEqual(run.errors, [])
        values = [f["value"] for f in run.result()["findings"]]
        self.assertEqual(values, ["[2001:db8::10]:22/tcp", "openssh/9.6p1"])

    def test_malformed_xml_fails_with_a_clear_error(self):
        good = xml('<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/></port>')
        for raw in (good[: len(good) // 2], "not xml at all", "<nmaprun><host>"):
            run = parsed(raw)
            self.assertEqual(run.result()["status"], "failed", msg=raw)
            self.assertEqual(len(run.errors), 1)
            self.assertTrue(run.errors[0].startswith("nmap's XML output could not be read"), msg=run.errors)
            self.assertEqual(run.result()["findings"], [])

    def test_malformed_xml_through_main_writes_a_failed_result(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "raw.xml")
            with open(path, "w", encoding="utf-8") as fh:
                fh.write("<?xml version='1.0'?><nmaprun><host><address addr=")
            out = os.path.join(d, "out")
            code = rw.main("nmap", nmap.parse, command=nmap.build_command, needs_target_type=True,
                           argv=["--target", "198.18.0.10", "--target-type", "ip", "--out", out, "--replay", path])
            with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
        self.assertEqual((code, doc["status"]), (0, "failed"))
        self.assertIn("could not be read", doc["errors"][0])
        self.assertNotIn("parser crashed", doc["errors"][0])

    def test_empty_output_and_wrong_root_are_errors(self):
        self.assertEqual(parsed("").errors, ["nmap wrote no XML output"])
        self.assertEqual(parsed("<other/>").errors, ["not nmap XML output (root element <other>)"])

    def test_host_timeout_is_an_error(self):
        # the shape nmap 7.95 writes for --host-timeout (captured against the lab with --host-timeout 1s)
        run = parsed(xml(host_attrs=' starttime="1794404118" endtime="1794404119" timedout="true"'))
        self.assertEqual(run.errors, ["nmap gave up on 198.18.0.10 after --host-timeout 480s; its ports are not reported"])
        self.assertEqual(run.result()["findings"], [])

    def test_another_host_is_an_error_not_a_finding(self):
        run = parsed(xml('<port protocol="tcp" portid="22"><state state="open" reason="syn-ack"/></port>',
                         addr="198.18.0.99"))
        self.assertEqual(run.errors, ["a host other than the target in nmap's output: '198.18.0.99'"])
        self.assertEqual(run.result()["findings"], [])

    def test_nmap_reported_error(self):
        run = parsed(xml(exit_="error").replace('exit="error"', 'exit="error" errormsg="Failed to open device"'))
        self.assertEqual(run.errors, ["nmap reported an error: Failed to open device"])


class FixtureTest(unittest.TestCase):
    """fixtures/raw.xml (ip mode) is checked by `pnpm tools:check nmap`; tools:check takes one raw file, so the
    port-mode capture (fixtures/port/) is replayed here, the same way."""

    def test_port_mode_fixture(self):
        folder = os.path.join(HERE, "fixtures", "port")
        with open(os.path.join(folder, "expected.json"), encoding="utf-8") as fh:
            expected = json.load(fh)
        with tempfile.TemporaryDirectory() as out:
            code = rw.main("nmap", nmap.parse, command=nmap.build_command, needs_target_type=True,
                           argv=["--target", expected["target"], "--target-type", expected["target_type"],
                                 "--out", out, "--replay", os.path.join(folder, "raw.xml")])
            with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                doc = json.load(fh)
        self.assertEqual(code, 0)
        self.assertEqual(doc["tool"], "nmap")
        got = {"target": doc["target"], "target_type": expected["target_type"], "status": doc["status"],
               "errors": doc["errors"], "findings": doc["findings"]}
        self.assertEqual(got, expected)


if __name__ == "__main__":
    unittest.main()
