"""testssl command and parsing, without the network. Run: python -m unittest discover -s tools/tls/testssl"""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as testssl  # noqa: E402

URL = "https://lab.northwind.example/"
PORT = "198.18.0.10:443/tcp"
IP = "198.18.0.10"
FP = "b17f047e99eb51cf4b801320e453f9031f3df2be1ef20f46330e6e7871d281f6"
FIXTURES = os.path.join(HERE, "fixtures")


def fixture(name):
    with open(os.path.join(FIXTURES, name), encoding="utf-8") as fh:
        return fh.read()


def parsed(raw, target=URL, target_type="url", errors=()):
    run = rw.ToolRun("testssl", target)
    run.target_type = target_type
    run.errors.extend(errors)
    if not isinstance(raw, str):
        raw = json.dumps(raw)
    testssl.parse(raw, run, target)
    return run


def item(id_, finding, severity="INFO", ip=f"lab.northwind.example/{IP}", port="443", **extra):
    return {"id": id_, "ip": ip, "port": port, "severity": severity, "finding": finding, **extra}


def cert_items(fp, suffix="", trusted=True, cn="lab.northwind.example"):
    s = f" <hostCert#{suffix}>" if suffix else ""
    return [
        item(f"cert_fingerprintSHA256{s}", fp.upper()),
        item(f"cert_commonName{s}", cn, "OK"),
        item(f"cert_subjectAltName{s}", f"{cn} *.{cn}"),
        item(f"cert_caIssuers{s}", "Example CA"),
        item(f"cert_notBefore{s}", "2026-01-02 03:04"),
        item(f"cert_notAfter{s}", "2027-01-02 03:04", "OK"),
        item(f"cert_chain_of_trust{s}", "passed." if trusted else "failed (self signed).",
             "OK" if trusted else "CRITICAL"),
    ]


def by_type(run, ntype):
    return [f for f in run.result()["findings"] if f["type"] == ntype]


class Command(unittest.TestCase):
    def test_url_argv(self):
        cmd = testssl.build_command(URL, "url", "/tmp/x/t.json")
        self.assertEqual(cmd, [
            "/opt/testssl/testssl.sh", "--openssl", "/opt/testssl/bin/openssl.Linux.x86_64", "-p", "-s", "-S", "-U",
            "--jsonfile", "/tmp/x/t.json", "--nodns", "min", "--ip", "one", "--warnings", "batch", "--color", "0",
            "--quiet", "--disable-rating", "--connect-timeout", "10", "--openssl-timeout", "10", URL])

    def test_never_headers_starttls_phone_out_or_client_simulation(self):
        for target, ttype in ((URL, "url"), (PORT, "port")):
            cmd = testssl.build_command(target, ttype, "/tmp/t.json")
            for flag in ("-h", "--headers", "-t", "--starttls", "--phone-out", "-c", "--client-simulation", "-e",
                         "-E", "--each-cipher", "--cipher-per-proto", "--mx", "--file", "--proxy", "--ids-friendly"):
                self.assertNotIn(flag, cmd, flag)
            self.assertEqual(cmd[cmd.index("--nodns") + 1], "min")
            self.assertEqual(cmd[cmd.index("--ip") + 1], "one")

    def test_port_target(self):
        self.assertEqual(testssl.build_command(PORT, "port", "/t.json")[-1], "198.18.0.10:443")
        cmd = testssl.build_command("[2001:db8::1]:8443/tcp", "port", "/t.json")
        self.assertEqual(cmd[-2:], ["-6", "[2001:db8::1]:8443"])

    def test_refused_targets(self):
        for target, ttype in (("http://lab.northwind.example/", "url"), ("ftp://x.example/", "url"),
                              ("198.18.0.10:53/udp", "port"), ("lab.northwind.example:443/tcp", "port"),
                              ("lab.northwind.example", "subdomain"), (URL, None)):
            with self.assertRaises(ValueError, msg=target):
                testssl.build_command(target, ttype, "/t.json")

    def test_checks_narrowing_is_tests_only(self):
        self.assertEqual(testssl.split_checks(["--checks", "protocols,defaults", "--target", URL]),
                         (("protocols", "defaults"), ["--target", URL]))
        cmd = testssl.build_command(URL, "url", "/t.json", ("protocols", "defaults"))
        self.assertIn("-p", cmd)
        self.assertIn("-S", cmd)
        self.assertNotIn("-U", cmd)
        self.assertNotIn("-s", cmd)
        for bad in ("", "headers", "protocols,starttls"):
            with self.assertRaises(ValueError):
                testssl.parse_checks(bad)

    def test_tool_json(self):
        with open(os.path.join(HERE, "tool.json"), encoding="utf-8") as fh:
            spec = json.load(fh)
        self.assertEqual(spec["accepts"], ["url", "port"])
        self.assertEqual((spec["mode"], spec["external"], spec["timeoutSec"]), ("active", [], 900))
        self.assertIn("{targetType}", spec["argv"])
        self.assertNotIn("--checks", " ".join(spec["argv"]))
        for probe in ("Heartbleed", "ROBOT", "Ticketbleed", "BREACH", "one address", "no other host"):
            self.assertIn(probe, spec["contacts"])


class Parse(unittest.TestCase):
    def test_lab_url_fixture(self):
        run = parsed(fixture("raw.json"))
        self.assertEqual(run.errors, [])
        (port,) = by_type(run, "port")
        self.assertEqual((port["value"], port["parent"], port["data"]),
                         (f"{IP}:443/tcp", {"type": "ip", "value": IP}, {"service": "https"}))
        (url,) = by_type(run, "url")
        self.assertEqual((url["value"], url["relation"], url["parent"]["value"]), (URL, "serves", f"{IP}:443/tcp"))
        (cert,) = by_type(run, "certificate")
        self.assertEqual((cert["value"], cert["relation"], cert["parent"]["value"]),
                         (FP, "has_certificate", f"{IP}:443/tcp"))
        self.assertEqual(cert["data"], {
            "subject": "lab.northwind.example", "sans": ["lab.northwind.example", "elsewhere.northwind.example"],
            "issuer": "lab.northwind.example", "not_before": "2026-11-03T09:13:00Z",
            "not_after": "2029-02-05T09:13:00Z", "trusted": False, "ip": IP})
        vulns = {f["value"]: f for f in by_type(run, "vulnerability")}
        self.assertEqual({v: f["severity"] for v, f in vulns.items()}, {
            "cipherlist_OBSOLETED": "low", "cert_chain_of_trust": "critical", "cert_extlifeSpan": "medium",
            "cert_revocation": "high", "CVE-2013-0169": "low"})
        for f in vulns.values():
            self.assertEqual((f["parent"], f["relation"]), ({"type": "url", "value": URL}, "has_vulnerability"))
            self.assertEqual(f["data"]["ip"], IP)
        self.assertEqual(vulns["CVE-2013-0169"]["data"]["id"], "LUCKY13")
        self.assertEqual(vulns["CVE-2013-0169"]["data"]["cwe"], "CWE-310")

    def test_ok_info_warn_are_not_findings(self):
        run = parsed(fixture("raw.json"))
        values = {f["value"] for f in by_type(run, "vulnerability")}
        for id_ in ("engine_problem", "SSLv3", "TLS1_3", "heartbleed", "BREACH", "cert_trust", "service"):
            self.assertNotIn(id_, values)

    def test_port_target_drops_cert_trust(self):
        run = parsed(fixture("port.json"), target=PORT, target_type="port")
        self.assertEqual(run.errors, [])
        self.assertEqual(by_type(run, "port") + by_type(run, "url") + by_type(run, "ip"), [])
        (cert,) = by_type(run, "certificate")
        self.assertEqual(cert["parent"], {"type": "port", "value": PORT})
        vulns = by_type(run, "vulnerability")
        self.assertNotIn("cert_trust", {f["value"] for f in vulns})
        self.assertEqual(len(vulns), 5)
        self.assertTrue(all(f["parent"] == {"type": "port", "value": PORT} for f in vulns))
        # on a url target, the same cert_trust HIGH would be reported
        run = parsed(fixture("port.json"), target=URL)
        self.assertIn("cert_trust", {f["value"] for f in by_type(run, "vulnerability")})

    def test_not_tls(self):
        run = parsed(fixture("not-tls.json"), target="198.18.0.10:8080/tcp", target_type="port",
                     errors=["exit code 245: "])
        doc = run.result()
        self.assertEqual((doc["status"], doc["findings"]), ("failed", []))
        self.assertEqual(doc["errors"], ["no TLS service on 198.18.0.10:8080"])

    def test_closed(self):
        doc = parsed(fixture("closed.json"), target="198.18.0.10:9/tcp", target_type="port",
                     errors=["exit code 246: "]).result()
        self.assertEqual((doc["status"], doc["findings"]), ("failed", []))
        self.assertEqual(len(doc["errors"]), 1)
        self.assertTrue(doc["errors"][0].startswith("can't connect to 198.18.0.10:9: closed, refused or filtered"))

    def test_no_address(self):
        doc = parsed(fixture("no-address.json"), target="https://nothere.northwind.example/").result()
        self.assertEqual((doc["status"], doc["findings"]), ("failed", []))
        self.assertIn("nothere.northwind.example did not resolve", doc["errors"][0])

    def test_two_certificates(self):
        fp2 = "ab" * 32
        items = [item("service", "HTTP")] + cert_items(FP, "1") + cert_items(fp2, "2", trusted=False)
        run = parsed(items)
        certs = {f["value"]: f["data"] for f in by_type(run, "certificate")}
        self.assertEqual(set(certs), {FP, fp2})
        self.assertTrue(certs[FP]["trusted"])
        self.assertFalse(certs[fp2]["trusted"])
        self.assertEqual(certs[FP]["sans"], ["lab.northwind.example", "*.lab.northwind.example"])
        (v,) = by_type(run, "vulnerability")
        self.assertEqual((v["value"], v["data"]["certificate"], v["data"]["id"]),
                         ("cert_chain_of_trust", fp2, "cert_chain_of_trust"))

    def test_several_cves(self):
        run = parsed([item("SWEET32", "uses 64 bit block ciphers", "LOW", cve="CVE-2016-6329 cve-2016-2183",
                           cwe="CWE-327")])
        (v,) = by_type(run, "vulnerability")
        self.assertEqual(v["value"], "CVE-2016-2183")
        self.assertEqual(v["data"]["cves"], ["CVE-2016-2183", "CVE-2016-6329"])
        self.assertEqual(v["data"]["id"], "SWEET32")

    def test_unclosed_json_from_a_timeout_is_still_read(self):
        raw = fixture("raw.json").rstrip().rstrip("]").rstrip()
        run = parsed(raw, errors=["timed out after 880s; kept the output so far"])
        self.assertEqual(run.result()["status"], "partial")
        self.assertEqual(len(by_type(run, "vulnerability")), 5)

    def test_bad_output(self):
        for raw, msg in (("", "wrote no results"), ("nope", "could not be read"), ('{"a": 1}', "not a list")):
            doc = parsed(raw).result()
            self.assertEqual(doc["status"], "failed", raw)
            self.assertIn(msg, doc["errors"][0], raw)

    def test_refused_target_keeps_one_error(self):
        doc = parsed("", target="http://lab.northwind.example/").result()
        self.assertEqual(doc["status"], "failed")
        self.assertEqual(len(doc["errors"]), 1)
        self.assertIn("https://", doc["errors"][0])


if __name__ == "__main__":
    unittest.main()
