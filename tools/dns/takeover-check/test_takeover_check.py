"""Unit tests for takeover-check. Run: python -m unittest discover -s tools/dns/takeover-check (pnpm test runs them)."""

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as tc  # noqa: E402

T = "app.northwind.example"
AT = "2026-11-22T10:00:00Z"
VERISIGN = "https://rdap.verisign.com/com/v1/"


# ------------------------------------------------------------------------------------------------- transcripts

def dns_cname(name, cname):
    line = {"host": name, "ttl": 300, "resolver": ["127.0.0.11:53"], "cname": [cname], "status_code": "NOERROR"}
    return {"kind": "dns", "query": "cname", "name": name, "argv": ["dnsx", "-l", name], "at": AT, "exit": 0,
            "stdout": json.dumps(line) + "\n", "stderr": "", "error": None}


def dns_end(name, status):
    """A name with no CNAME: dnsx -cname prints nothing, dnsx -rcode prints the status."""
    empty = {"kind": "dns", "query": "cname", "name": name, "argv": ["dnsx"], "at": AT, "exit": 0, "stdout": "",
             "stderr": "", "error": None}
    line = {"host": name, "resolver": ["127.0.0.11:53"], "status_code": status}
    rc = {**empty, "query": "rcode", "stdout": json.dumps(line) + "\n"}
    return [empty, rc]


def rdap_body(domain, expires="2027-01-02T03:04:05Z", created="2001-02-03T04:05:06Z", registrar="Example Registrar"):
    return json.dumps({
        "objectClassName": "domain", "ldhName": domain.upper(),
        "entities": [{"objectClassName": "entity", "roles": ["registrar"],
                      "vcardArray": ["vcard", [["version", {}, "text", "4.0"], ["fn", {}, "text", registrar]]]}],
        "events": [{"eventAction": "registration", "eventDate": created},
                   {"eventAction": "expiration", "eventDate": expires},
                   {"eventAction": "last changed", "eventDate": "2026-01-01T00:00:00Z"}],
    })


def rdap(domain, status=200, body=None, attempts=None, base=VERISIGN):
    if status == 200 and body is None:
        body = rdap_body(domain)
    return {"kind": "rdap", "domain": domain, "url": tc.rdap_url(base, domain),
            "attempts": attempts or [{"at": AT, "status": status, "error": None}], "status": status, "body": body}


def whois(domain, stdout, exit_code=0):
    return {"kind": "whois", "domain": domain, "argv": [tc.WHOIS, domain], "at": AT, "exit": exit_code,
            "stdout": stdout, "stderr": "", "error": None}


def transcript(target, exchanges, bootstrap=None):
    boot = {"northwind.example": {"entry": "example", "servers": [VERISIGN]}}
    boot.update(bootstrap or {})
    flat = []
    for e in exchanges:
        flat.extend(e if isinstance(e, list) else [e])
    return {"transcript": 1, "tool": tc.TOOL, "target": target, "target_type": "subdomain", "data": {},
            "bootstrap": boot, "exchanges": flat}


def replay(t, target=T, target_type="subdomain"):
    run = rw.ToolRun(tc.TOOL, target)
    run.target_type = target_type
    run.command = f"{tc.TOOL} {target} (replayed)"
    tc.parse(json.dumps(t), run, target)
    return run.result()


def own():
    return rdap("northwind.example")


def findings(doc, ftype=None):
    return [f for f in doc["findings"] if ftype is None or f["type"] == ftype]


def vulns(doc):
    return {f["value"]: f for f in findings(doc, "vulnerability")}


# ---------------------------------------------------------------------------------------------------- fixtures

class FixtureTest(unittest.TestCase):
    """fixtures/raw.json is checked by `pnpm tools:check takeover-check`; the seven case folders are replayed here,
    the same way. With REDWHALE_UPDATE_FIXTURES=1 their expected.json is rewritten (then read it)."""

    def test_case_folders(self):
        root = os.path.join(HERE, "fixtures")
        cases = sorted(d for d in os.listdir(root) if os.path.isdir(os.path.join(root, d)))
        self.assertEqual(len(cases), 7)
        for case in cases:
            with self.subTest(case=case):
                folder = os.path.join(root, case)
                with open(os.path.join(folder, "expected.json"), encoding="utf-8") as fh:
                    expected = json.load(fh)
                with tempfile.TemporaryDirectory() as out:
                    code = rw.main(tc.TOOL, tc.parse, fetch=tc.fetch, needs_target_type=True, needs_resolvers=True,
                                   argv=["--target", expected["target"], "--target-type", expected["target_type"],
                                         "--out", out, "--replay", os.path.join(folder, "raw.json")])
                    with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                        doc = json.load(fh)
                self.assertEqual(code, 0)
                got = {"target": doc["target"], "target_type": expected["target_type"], "status": doc["status"],
                       "errors": doc["errors"], "findings": doc["findings"]}
                if os.environ.get("REDWHALE_UPDATE_FIXTURES") == "1":
                    with open(os.path.join(folder, "expected.json"), "w", encoding="utf-8", newline="\n") as fh:
                        json.dump(got, fh, indent=2, ensure_ascii=False)
                        fh.write("\n")
                    continue
                self.assertEqual(got, expected)


# ------------------------------------------------------------------------------------------------------ chains

class ChainTest(unittest.TestCase):
    def test_no_cname_only_the_own_domain_is_looked_up_and_the_target_is_never_a_finding(self):
        doc = replay(transcript(T, [dns_end(T, "NOERROR"), own()]))
        self.assertEqual(doc["status"], "success")
        self.assertEqual([(f["type"], f["value"]) for f in doc["findings"]], [("domain", "northwind.example")])
        self.assertNotIn("parent", doc["findings"][0])  # the own domain: evidence it is registered, no parent
        self.assertEqual(doc["findings"][0]["data"]["expires_at"], "2027-01-02T03:04:05Z")

    def test_hops_are_cname_to_edges_and_hang_under_their_registrable_domain(self):
        doc = replay(transcript(T, [dns_cname(T, "edge.cdn.partner.com"), dns_end("edge.cdn.partner.com", "NOERROR"),
                                    own(), rdap("partner.com")],
                                {"partner.com": {"entry": "com", "servers": [VERISIGN]}}))
        hops = findings(doc, "subdomain")
        self.assertEqual([(f["value"], f["parent"]["value"], f["relation"]) for f in hops], [
            ("edge.cdn.partner.com", T, "cname_to"), ("edge.cdn.partner.com", "partner.com", "has_subdomain")])
        self.assertEqual(hops[0]["data"], {"rcode": "NOERROR"})
        domains = {f["value"]: f for f in findings(doc, "domain")}
        self.assertEqual(sorted(domains), ["northwind.example", "partner.com"])
        self.assertNotIn("parent", domains["partner.com"])  # external domains have no parent
        self.assertEqual(domains["partner.com"]["data"]["registrar"], "Example Registrar")
        self.assertEqual(vulns(doc), {})

    def test_a_hop_that_is_a_registrable_domain_carries_its_registration(self):
        doc = replay(transcript(T, [dns_cname(T, "partner.com"), dns_end("partner.com", "NOERROR"), own(),
                                    rdap("partner.com")],
                                {"partner.com": {"entry": "com", "servers": [VERISIGN]}}))
        hop = [f for f in findings(doc, "domain") if f["value"] == "partner.com"]
        self.assertEqual(len(hop), 1)
        self.assertEqual((hop[0]["parent"]["value"], hop[0]["relation"]), (T, "cname_to"))
        self.assertEqual((hop[0]["data"]["rcode"], hop[0]["data"]["registered"]), ("NOERROR", True))

    def test_a_loop_stops_with_an_error_and_never_reports_the_target(self):
        b = "b.northwind.example"
        doc = replay(transcript(T, [dns_cname(T, b), dns_cname(b, T), own()]))
        self.assertEqual(doc["status"], "partial")
        self.assertEqual(doc["errors"], [f"CNAME loop: {b} points back at {T}; stopped"])
        self.assertNotIn(T, [f["value"] for f in doc["findings"]])
        self.assertEqual(findings(doc, "subdomain")[0]["data"]["loops_to"], T)

    def test_at_most_ten_hops(self):
        names = [T] + [f"h{i}.northwind.example" for i in range(1, 12)]
        ex = [dns_cname(a, b) for a, b in zip(names, names[1:])]
        doc = replay(transcript(T, [*ex, own()]))
        hops = [f["value"] for f in findings(doc, "subdomain") if f["relation"] == "cname_to"]
        self.assertEqual(hops, names[1:11])
        self.assertEqual(doc["errors"], ["CNAME chain longer than 10 hops; stopped at h10.northwind.example -> "
                                         "h11.northwind.example"])

    def test_rcode_of_each_hop_is_recorded(self):
        doc = replay(transcript(T, [dns_cname(T, "x.partner.com"), dns_end("x.partner.com", "SERVFAIL"), own(),
                                    rdap("partner.com")], {"partner.com": {"entry": "com", "servers": [VERISIGN]}}))
        self.assertEqual(findings(doc, "subdomain")[0]["data"]["rcode"], "SERVFAIL")
        self.assertEqual(vulns(doc), {})  # SERVFAIL is not dangling

    def test_a_cname_to_a_public_suffix_stops(self):
        doc = replay(transcript(T, [dns_cname(T, "co.uk"), own()]))
        self.assertEqual(doc["errors"], [f"CNAME target co.uk of {T} is a public suffix, not a name; stopped"])

    def test_a_truncated_transcript_says_what_is_missing_and_keeps_the_rest(self):
        doc = replay(transcript(T, [dns_cname(T, "x.partner.com"), own()],
                                {"partner.com": {"entry": "com", "servers": [VERISIGN]}}))
        self.assertIn("the transcript has no answer for dns cname x.partner.com; the chain stops there", doc["errors"])
        self.assertIn("x.partner.com", [f["value"] for f in doc["findings"]])
        self.assertEqual(doc["status"], "partial")

    def test_a_transcript_for_another_target_is_refused(self):
        doc = replay(transcript("other.northwind.example", [dns_end("other.northwind.example", "NOERROR"), own()]))
        self.assertEqual(doc["status"], "failed")
        self.assertIn("transcript is for subdomain other.northwind.example", doc["errors"][0])


# ------------------------------------------------------------------------------------------------------- rules

class VulnerabilityTest(unittest.TestCase):
    BOOT = {"partner.com": {"entry": "com", "servers": [VERISIGN]}}

    def run_chain(self, hop, rcode, reg=None, boot=None):
        ex = [dns_cname(T, hop), dns_end(hop, rcode), own()]
        if reg is not None:
            ex.append(reg)
        return replay(transcript(T, ex, boot if boot is not None else self.BOOT))

    def test_unregistered_domain_is_critical(self):
        doc = self.run_chain("cdn.partner.com", "NXDOMAIN", rdap("partner.com", 404, None))
        v = vulns(doc)
        self.assertEqual(sorted(v), [tc.VULN_UNREGISTERED])  # not also dangling
        f = v[tc.VULN_UNREGISTERED]
        self.assertEqual((f["severity"], f["parent"], f["relation"]),
                         ("critical", {"type": "subdomain", "value": T}, "has_vulnerability"))
        self.assertEqual(f["data"]["chain"], [T, "cdn.partner.com"])
        self.assertEqual((f["data"]["name"], f["data"]["domain"]), ("cdn.partner.com", "partner.com"))
        self.assertIn("partner.com is not registered (RDAP 404 from rdap.verisign.com)", f["data"]["reason"])

    def test_dangling_under_a_registered_external_domain_is_medium(self):
        f = vulns(self.run_chain("old.partner.com", "NXDOMAIN", rdap("partner.com")))[tc.VULN_DANGLING]
        self.assertEqual(f["severity"], "medium")
        self.assertEqual((f["data"]["name"], f["data"]["domain"]), ("old.partner.com", "partner.com"))

    def test_dangling_under_a_private_suffix_names_the_service(self):
        doc = self.run_chain("gone.herokuapp.com", "NXDOMAIN", boot={})
        f = vulns(doc)[tc.VULN_DANGLING]
        self.assertEqual(f["data"]["service"], "herokuapp.com")
        self.assertNotIn("herokuapp.com", [x["value"] for x in findings(doc, "domain")])  # never looked up
        self.assertEqual(findings(doc, "subdomain")[0]["data"], {"rcode": "NXDOMAIN", "service": "herokuapp.com"})

    def test_no_vulnerability_when_the_registration_is_unknown(self):
        timeout = rdap("partner.com", None, None, [{"at": AT, "status": None, "error": "URLError: timed out"}] * 3)
        doc = self.run_chain("old.partner.com", "NXDOMAIN", timeout)
        self.assertEqual(vulns(doc), {})
        self.assertEqual(doc["errors"], ["registration of partner.com unknown: URLError: timed out from "
                                         "rdap.verisign.com after 3 tries"])

    def test_a_missing_name_in_the_targets_own_domain_is_not_a_takeover(self):
        # only the zone owner can create it; the hop is still reported, with its rcode
        doc = self.run_chain("gone.northwind.example", "NXDOMAIN", boot={})
        self.assertEqual(vulns(doc), {})
        hop = [f for f in findings(doc, "subdomain") if f["relation"] == "cname_to"]
        self.assertEqual([(f["value"], f["data"]) for f in hop], [("gone.northwind.example", {"rcode": "NXDOMAIN"})])

    def test_resolving_names_are_not_dangling(self):
        self.assertEqual(vulns(self.run_chain("gone.herokuapp.com", "NOERROR", boot={})), {})

    def test_the_targets_own_domain_unregistered_is_critical(self):
        doc = replay(transcript(T, [dns_end(T, "NOERROR"), rdap("northwind.example", 404, None)]))
        self.assertEqual(vulns(doc)[tc.VULN_UNREGISTERED]["data"]["name"], T)


# ------------------------------------------------------------------------------------------------ RDAP / WHOIS

class RdapParseTest(unittest.TestCase):
    def test_200(self):
        reg = tc.rdap_registration(rdap("partner.com", body=rdap_body("partner.com", "2027-01-02T03:04:05.000+02:00")),
                                   "partner.com")
        self.assertEqual(reg, {"registered": True, "expires_at": "2027-01-02T01:04:05Z", "registrar": "Example Registrar",
                               "created_at": "2001-02-03T04:05:06Z", "source": "rdap", "checked_at": AT})

    def test_200_without_events_or_entities(self):
        reg = tc.rdap_registration(rdap("partner.com", body='{"objectClassName":"domain"}'), "partner.com")
        self.assertEqual((reg["registered"], reg["expires_at"], reg["registrar"]), (True, None, None))

    def test_an_unreadable_date_is_none_never_a_guess(self):
        reg = tc.rdap_registration(rdap("partner.com", body=rdap_body("partner.com", "next year")), "partner.com")
        self.assertEqual((reg["registered"], reg["expires_at"]), (True, None))

    def test_404(self):
        reg = tc.rdap_registration(rdap("partner.com", 404, None), "partner.com")
        self.assertEqual((reg["registered"], reg["reason"]), (False, "RDAP 404 from rdap.verisign.com"))

    def test_malformed(self):
        for body, why in (("<html>busy</html>", "was not JSON"), ("[1]", "was not a JSON object")):
            reg = tc.rdap_registration(rdap("partner.com", body=body), "partner.com")
            self.assertEqual(reg["registered"], None)
            self.assertIn(why, reg["reason"])

    def test_an_answer_for_another_name(self):
        reg = tc.rdap_registration(rdap("partner.com", body=rdap_body("other.com")), "partner.com")
        self.assertIn("answered for another name", reg["reason"])

    def test_redirect_is_unknown_and_names_the_host(self):
        ex = rdap("partner.com", 301, None, [{"at": AT, "status": 301, "error": None,
                                              "location": "https://rdap.elsewhere.example/domain/partner.com"}])
        reg = tc.rdap_registration(ex, "partner.com")
        self.assertEqual((reg["registered"], reg["reason"]),
                         (None, "RDAP 301 redirect to rdap.elsewhere.example (not followed)"))

    def test_other_status(self):
        reg = tc.rdap_registration(rdap("partner.com", 503, None, [{"at": AT, "status": 503, "error": None}] * 3),
                                   "partner.com")
        self.assertEqual(reg["reason"], "RDAP 503 from rdap.verisign.com after 3 tries")


class WhoisParseTest(unittest.TestCase):
    IO = ("Domain Name: partner.io\nRegistry Domain ID: REDACTED\nCreation Date: 2012-10-04T20:55:32Z\n"
          "Registry Expiry Date: 2028-10-04T20:55:32Z\nRegistrar: Example Registrar\n")

    def test_expiry_label(self):
        reg = tc.whois_registration(whois("partner.io", self.IO), "partner.io")
        self.assertEqual(reg, {"registered": True, "expires_at": "2028-10-04T20:55:32Z", "registrar": "Example Registrar",
                               "created_at": "2012-10-04T20:55:32Z", "source": "whois", "checked_at": AT})

    def test_other_labels_and_formats(self):
        for text, expires in (("paid-till: 2027-01-31T21:00:00Z\n", "2027-01-31T21:00:00Z"),
                              ("Expiry Date: 2027.03.01\n", "2027-03-01T00:00:00Z"),
                              ("expires:      2027-05-06\n", "2027-05-06T00:00:00Z"),
                              ("Expiration Date: 07-Jun-2027\n", "2027-06-07T00:00:00Z")):
            with self.subTest(text=text):
                self.assertEqual(tc.whois_registration(whois("p.example", text), "p.example")["expires_at"], expires)

    def test_no_expiry_is_unknown_never_not_registered(self):
        for text in ("Domain: partner.de\nStatus: connect\n", "No match for partner.io\n", "NOT FOUND\n", ""):
            with self.subTest(text=text):
                reg = tc.whois_registration(whois("partner.io", text), "partner.io")
                self.assertEqual((reg["registered"], reg["reason"]), (None, "no expiry date in the WHOIS answer"))

    def test_an_expiry_date_we_dont_understand_is_unknown(self):
        reg = tc.whois_registration(whois("partner.io", "Expiry Date: sometime in 2027\n"), "partner.io")
        self.assertEqual(reg["registered"], None)
        self.assertIn("not understood", reg["reason"])

    def test_whois_failing_is_unknown(self):
        self.assertEqual(tc.whois_registration(whois("partner.io", "", 1), "partner.io")["reason"], "whois exited with 1")

    def test_a_tld_without_rdap_goes_to_whois(self):
        doc = replay(transcript(T, [dns_cname(T, "docs.partner.io"), dns_end("docs.partner.io", "NOERROR"), own(),
                                    whois("partner.io", self.IO)], {"partner.io": {"entry": None, "servers": []}}))
        d = [f for f in findings(doc, "domain") if f["value"] == "partner.io"][0]
        self.assertEqual((d["data"]["source"], d["data"]["expires_at"]), ("whois", "2028-10-04T20:55:32Z"))


class BootstrapTest(unittest.TestCase):
    def test_longest_entry_https_only(self):
        table = {"com": ["http://plain.example/", "https://rdap.example/com/"], "co.uk": ["https://x.example/"],
                 "uk": ["https://y.example/"]}
        self.assertEqual(tc.bootstrap_lookup(table, "partner.com"), ("com", ["https://rdap.example/com/"]))
        self.assertEqual(tc.bootstrap_lookup(table, "partner.co.uk"), ("co.uk", ["https://x.example/"]))
        self.assertEqual(tc.bootstrap_lookup(table, "partner.io"), (None, []))

    def test_bundled_bootstrap_loads(self):
        table = tc.load_bootstrap(tc.BOOTSTRAP_FILE)
        self.assertEqual(tc.bootstrap_lookup(table, "partner.com")[1], [VERISIGN])
        self.assertEqual(tc.bootstrap_lookup(table, "partner.io"), (None, []))


# -------------------------------------------------------------------------------------------------- live net

class FakeClock:
    def __init__(self):
        self.t = 0.0
        self.slept = []

    def clock(self):
        return self.t

    def sleep(self, s):
        self.slept.append(round(s, 3))
        self.t += s


class FakeResponse(io.BytesIO):
    def __init__(self, status, body):
        super().__init__(body.encode())
        self.status = status


def live(answers, timeout=300, clock=None):
    """A LiveNet whose opener answers from `answers` (a list of statuses / exceptions / (200, body)), in order."""
    clock = clock or FakeClock()
    calls = []

    def opener(req, timeout):
        calls.append((req.full_url, timeout, dict(req.header_items())))
        a = answers.pop(0)
        clock.t += 0.2
        if isinstance(a, Exception):
            raise a
        if isinstance(a, tuple):
            return FakeResponse(*a)
        raise urllib.error.HTTPError(req.full_url, a, "x", {"Location": "https://rdap.elsewhere.example/d"}, None)

    net = tc.LiveNet(T, "subdomain", timeout, bootstrap={"com": [VERISIGN]}, opener=opener, sleep=clock.sleep,
                     clock=clock.clock, stamp=lambda: AT)
    return net, calls, clock


class LiveRdapTest(unittest.TestCase):
    def test_retries_with_backoff_then_answers(self):
        net, calls, clock = live([urllib.error.URLError("timed out"), 503, (200, rdap_body("partner.com"))])
        ex = net.rdap("partner.com", VERISIGN)
        self.assertEqual([a["status"] for a in ex["attempts"]], [None, 503, 200])
        self.assertEqual(ex["attempts"][0]["error"], "URLError: timed out")
        self.assertEqual(clock.slept, [2, 5])
        self.assertEqual(calls[0][0], "https://rdap.verisign.com/com/v1/domain/partner.com")
        self.assertEqual(calls[0][2]["User-agent"], tc.USER_AGENT)
        self.assertIs(net.transcript["exchanges"][-1], ex)

    def test_404_and_redirects_are_not_retried(self):
        net, calls, _ = live([404])
        self.assertEqual(net.rdap("partner.com", VERISIGN)["status"], 404)
        net, calls, _ = live([301])
        ex = net.rdap("partner.com", VERISIGN)
        self.assertEqual((len(calls), ex["attempts"][0]["location"]), (1, "https://rdap.elsewhere.example/d"))

    def test_the_real_opener_never_follows_a_redirect(self):
        self.assertIsNone(tc.NoRedirect().redirect_request(None, None, 301, "", {}, "https://elsewhere.example/"))

    def test_one_request_per_second_per_server(self):
        net, _, clock = live([(200, rdap_body("a.com")), (200, rdap_body("b.com"))])
        net.rdap("a.com", VERISIGN)
        net.rdap("b.com", VERISIGN)
        self.assertEqual(clock.slept, [0.8])  # 0.2 s spent on the first request, so 0.8 s more

    def test_out_of_time_stops_trying(self):
        net, calls, _ = live([], timeout=1)
        ex = net.rdap("partner.com", VERISIGN)
        self.assertEqual((calls, ex["attempts"][0]["error"]), ([], "out of time"))

    def test_bootstrap_entries_used_are_recorded(self):
        net, _, _ = live([])
        self.assertEqual(net.rdap_servers("partner.com"), [VERISIGN])
        self.assertEqual(net.rdap_servers("partner.io"), [])
        self.assertEqual(net.transcript["bootstrap"], {"partner.com": {"entry": "com", "servers": [VERISIGN]},
                                                       "partner.io": {"entry": None, "servers": []}})


class LiveCommandTest(unittest.TestCase):
    def setUp(self):
        self.old = rw.RESOLV_CONF
        self.dir = tempfile.TemporaryDirectory()
        rw.RESOLV_CONF = os.path.join(self.dir.name, "resolv.conf")
        with open(rw.RESOLV_CONF, "w", encoding="utf-8") as fh:
            fh.write("nameserver 127.0.0.11\n")

    def tearDown(self):
        rw.RESOLV_CONF = self.old
        self.dir.cleanup()

    def test_dnsx_one_name_own_resolver_never_brute_force(self):
        for query in ("cname", "rcode"):
            argv = tc.dnsx_argv(T, query, rw.resolver_args())
            self.assertEqual(argv[:3], [tc.DNSX, "-l", T])
            self.assertEqual(argv[-2:], ["-r", "127.0.0.11:53"])
            self.assertFalse({"-d", "-w", "-domain", "-wordlist"} & set(argv))
        self.assertIn("-cname", tc.dnsx_argv(T, "cname", []))
        self.assertIn("noerror,nxdomain,servfail,refused", tc.dnsx_argv(T, "rcode", []))

    def test_live_dns_and_whois_are_recorded(self):
        ran = []

        def runner(argv, **kw):
            ran.append(argv)
            return subprocess.CompletedProcess(argv, 0, stdout="out\n", stderr="")

        clock = FakeClock()
        net = tc.LiveNet(T, "subdomain", 300, bootstrap={}, runner=runner, sleep=clock.sleep, clock=clock.clock,
                         stamp=lambda: AT)
        ex = net.dns(T, "cname")
        self.assertEqual((ex["exit"], ex["stdout"], ex["argv"][-1]), (0, "out\n", "127.0.0.11:53"))
        net.whois("partner.io")
        net.whois("other.io")  # same TLD: whois picks the same server, so it waits a second
        self.assertEqual(ran[1:], [[tc.WHOIS, "partner.io"], [tc.WHOIS, "other.io"]])
        self.assertEqual(clock.slept, [1.0])

    def test_no_system_resolver_refuses_and_runs_nothing(self):
        rw.RESOLV_CONF = os.path.join(self.dir.name, "missing.conf")

        def boom(*a, **kw):
            raise AssertionError("nothing may run without a system resolver")

        old_run = subprocess.run
        subprocess.run = boom
        try:
            with tempfile.TemporaryDirectory() as out:
                code = rw.main(tc.TOOL, tc.parse, fetch=tc.fetch, needs_target_type=True, needs_resolvers=True,
                               argv=["--target", T, "--target-type", "subdomain", "--out", out])
                with open(os.path.join(out, "result.json"), encoding="utf-8") as fh:
                    doc = json.load(fh)
        finally:
            subprocess.run = old_run
        self.assertEqual(code, 0)
        self.assertEqual((doc["status"], doc["errors"]), ("failed", [rw.NO_RESOLVER]))

    def test_only_subdomains_and_plain_names(self):
        for target, target_type, why in ((T, "domain", "takes a subdomain, not a domain"),
                                         ("a.northwind.example,b.northwind.example", "subdomain", "not a hostname"),
                                         (rw.RESOLV_CONF, "subdomain", "not a hostname")):
            with self.subTest(target=target):
                run = rw.ToolRun(tc.TOOL, target)
                run.target_type = target_type
                self.assertEqual(tc.fetch(target, run, 300, net=object()), "")
                self.assertIn(why, run.errors[0])


if __name__ == "__main__":
    unittest.main()
