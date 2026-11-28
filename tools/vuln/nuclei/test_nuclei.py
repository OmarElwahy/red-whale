"""nuclei command and parsing, without the network. Run: python -m unittest discover -s tools/vuln/nuclei"""

import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "..", "..", "lib"))
import redwhale_tool as rw  # noqa: E402
import run as nuclei  # noqa: E402

TARGET = "https://lab.northwind.example/"
BASE = "https://lab.northwind.example"
EXCLUDED = ("intrusive", "dos", "fuzz", "bruteforce", "default-login", "osint", "ssrf", "oast", "proxy")


def line(template_id, matched_at=BASE, tags=("exposure",), severity="medium", matcher=None, extracted=None, cves=None,
         cvss=None, reference=None, name=None):
    info = {"name": name or f"{template_id} name", "tags": list(tags), "severity": severity,
            "classification": {"cve-id": cves, "cvss-score": cvss}}
    if reference is not None:
        info["reference"] = reference
    item = {"template-id": template_id, "info": info, "type": "http", "host": "lab.northwind.example",
            "url": BASE, "matched-at": matched_at, "timestamp": "2026-11-24T19:04:41Z", "matcher-status": True}
    if matcher:
        item["matcher-name"] = matcher
    if extracted is not None:
        item["extracted-results"] = extracted
    return json.dumps(item)


def parsed(*lines, target=TARGET, stderr=None):
    run = rw.ToolRun("nuclei", target)
    run.stderr = stderr
    nuclei.parse("\n".join(lines), run, target)
    return run


def found(run, ntype=None):
    return [f for f in run.result()["findings"] if ntype is None or f["type"] == ntype]


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

    def test_always_no_oast_no_redirects_no_updates_and_every_excluded_tag(self):
        for ids in ((), ("git-config",)):
            cmd = nuclei.build_command(TARGET, ids)
            for flag in ("-ni", "-dr", "-duc", "-or", "-ot", "-jsonl", "-nc"):
                self.assertIn(flag, cmd)
            self.assertEqual(set(self.arg(cmd, "-etags").split(",")), set(EXCLUDED))
            eid = set(self.arg(cmd, "-eid").split(","))
            self.assertEqual(len(eid), 23)
            # a side port, a token checked against its service's API, and the one seen on a real target
            for tid in ("hpe-autopass-panel", "slack-bot-token", "azure-domain-tenant", "nginx-status-403-bypass"):
                self.assertIn(tid, eid)
            self.assertEqual(self.arg(cmd, "-tags"), "cve,misconfig,exposure,tech,takeover")
            self.assertEqual(self.arg(cmd, "-pt"), "http")
            self.assertEqual(self.arg(cmd, "-t"), "/opt/nuclei-templates/http/")
            self.assertEqual(cmd[0], "/usr/local/bin/nuclei")

    def test_rate_retries_and_time_limit(self):
        cmd = nuclei.build_command(TARGET)
        self.assertEqual([self.arg(cmd, f) for f in ("-rl", "-c", "-retries", "-timeout", "-mt")],
                         ["5", "5", "1", "10", "55m"])

    def test_never_widening_or_outside_flags(self):
        cmd = nuclei.build_command(TARGET, ("git-config",))
        for flag in ("-fr", "-follow-redirects", "-headless", "-code", "-dast", "-lfa", "-ev", "-env-vars", "-pd",
                     "-dashboard", "-pdu", "-ut", "-up", "-ud", "-stats", "-uc", "-sresp", "-itags", "-it", "-esc",
                     "-passive", "-silent", "-nmhe"):
            self.assertNotIn(flag, cmd, flag)

    def test_target_without_trailing_slash_and_refuses_non_urls(self):
        self.assertEqual(self.arg(nuclei.build_command(TARGET), "-u"), BASE)
        self.assertEqual(self.arg(nuclei.build_command(f"{BASE}/app/"), "-u"), f"{BASE}/app")
        self.assertEqual(self.arg(nuclei.build_command(f"{BASE}/?a=1"), "-u"), f"{BASE}/?a=1")
        for bad in ("lab.northwind.example", "ftp://lab.northwind.example/", "1.2.3.4:443/tcp"):
            with self.assertRaises(ValueError):
                nuclei.build_command(bad)

    def test_resolvers_go_in_a_file(self):
        path = self.arg(nuclei.build_command(TARGET), "-r")
        with open(path, encoding="utf-8") as fh:
            self.assertEqual(fh.read(), "127.0.0.11:53\n")
        with open(rw.RESOLV_CONF, "w", encoding="utf-8") as fh:
            fh.write("")
        self.assertNotIn("-r", nuclei.build_command(TARGET))

    def test_template_ids_narrow_only_and_are_checked(self):
        self.assertNotIn("-id", nuclei.build_command(TARGET))
        self.assertEqual(self.arg(nuclei.build_command(TARGET, ["a", "b"]), "-id"), "a,b")
        ids, rest = nuclei.split_template_ids(["--target", TARGET, "--template-ids", "git-config,laravel-env",
                                               "--out", "o"])
        self.assertEqual((ids, rest), (["git-config", "laravel-env"], ["--target", TARGET, "--out", "o"]))
        self.assertEqual(nuclei.split_template_ids(["--template-ids=CVE-2021-41773"])[0], ["CVE-2021-41773"])
        for bad in (["--template-ids", "-t,/etc"], ["--template-ids", "a b"], ["--template-ids", ""],
                    ["--template-ids", ",".join(f"t{i}" for i in range(21))]):
            with self.assertRaises(ValueError):
                nuclei.split_template_ids(bad)
        self.assertEqual(nuclei.cli(["--target", TARGET, "--out", self.dir.name, "--template-ids", "-x"]), 2)

    def test_tool_json_never_passes_template_ids(self):
        with open(os.path.join(HERE, "tool.json"), encoding="utf-8") as fh:
            tool = json.load(fh)
        self.assertNotIn("--template-ids", " ".join(tool["argv"]))
        self.assertEqual((tool["mode"], tool["accepts"], tool["timeoutSec"]), ("active", ["url"], 3600))


class SeverityTest(unittest.TestCase):
    def test_kept_or_info(self):
        for given, want in (("info", "info"), ("low", "low"), ("Medium", "medium"), ("high", "high"),
                            ("critical", "critical"), ("unknown", "info"), ("", "info"), (None, "info"),
                            ("severe", "info")):
            run = parsed(line("t1", severity=given))
            self.assertEqual(found(run, "vulnerability")[0]["severity"], want, given)


class VulnerabilityTest(unittest.TestCase):
    def test_template_id_or_uppercased_first_cve(self):
        run = parsed(line("git-config"), line("CVE-x", cves=["cve-2021-42013", "cve-2021-41773"], severity="critical"))
        values = {f["value"]: f for f in found(run, "vulnerability")}
        self.assertEqual(set(values), {"git-config", "CVE-2021-41773"})
        self.assertEqual(values["CVE-2021-41773"]["data"]["cves"], ["CVE-2021-41773", "CVE-2021-42013"])
        self.assertNotIn("cves", values["git-config"]["data"])

    def test_one_finding_per_value_and_url_matchers_a_sorted_list(self):
        run = parsed(line("hdrs", matcher="x-frame-options"), line("hdrs", matcher="content-security-policy"),
                     line("hdrs", matcher="x-frame-options"), line("solo", matcher="m"))
        by = {f["value"]: f for f in found(run, "vulnerability")}
        self.assertEqual(len(by), 2)
        self.assertEqual(by["hdrs"]["data"]["matcher"], ["content-security-policy", "x-frame-options"])
        self.assertEqual(by["solo"]["data"]["matcher"], ["m"])
        self.assertNotIn("matcher", found(parsed(line("none")), "vulnerability")[0]["data"])

    def test_highest_severity_wins_on_merge(self):
        run = parsed(line("t", matcher="a", severity="low"), line("t", matcher="b", severity="high"))
        self.assertEqual(found(run, "vulnerability")[0]["severity"], "high")

    def test_extracted_values_are_masked_and_capped(self):
        run = parsed(line("git-config", extracted=["redwhale-lab:fake-not-a-secret", "AKIAABCDEFGHWXYZ"]))
        data = found(run, "vulnerability")[0]["data"]
        self.assertEqual(data["extracted"], ["AKIA****WXYZ", "redw****cret"])
        self.assertNotIn("fake-not-a-secret", json.dumps(run.result()))
        run = parsed(line("many", extracted=[f"value-number-{i:02d}" for i in range(9)]))
        self.assertEqual(len(found(run, "vulnerability")[0]["data"]["extracted"]), 5)

    def test_data_fields(self):
        run = parsed(line("git-config", matched_at=f"{BASE}/.git/config", cvss=5.3, name="Git Configuration",
                          reference=["https://a.example/1", "https://a.example/2"], tags=("config", "git", "exposure")))
        data = found(run, "vulnerability")[0]["data"]
        self.assertEqual(data, {"template": "git-config", "name": "Git Configuration",
                                "matched_at": f"{BASE}/.git/config", "cvss": 5.3,
                                "references": ["https://a.example/1", "https://a.example/2"],
                                "tags": ["config", "exposure", "git"]})
        run = parsed(line("r", reference="https://only.example/"))
        self.assertEqual(found(run, "vulnerability")[0]["data"]["references"], ["https://only.example/"])


class TechnologyTest(unittest.TestCase):
    def test_tech_tag_is_a_technology_with_its_version(self):
        run = parsed(line("php-detect", tags=("tech", "php"), severity="info", extracted=["8.3.12"]),
                     line("nginx-version", tags=("tech", "nginx"), severity="info", extracted=["nginx/1.30.6"]))
        techs = {f["value"]: f for f in found(run, "technology")}
        self.assertEqual(set(techs), {"php/8.3.12", "nginx/1.30.6"})
        self.assertEqual(techs["php/8.3.12"]["relation"], "uses_technology")
        self.assertEqual(techs["php/8.3.12"]["parent"], {"type": "url", "value": TARGET})
        self.assertEqual(techs["php/8.3.12"]["data"], {"template": "php-detect", "extracted": ["8.3.12"]})
        self.assertEqual(found(run, "vulnerability"), [])

    def test_matcher_names_the_technology_and_bare_names_drop_beside_a_version(self):
        run = parsed(line("tech-detect", tags=("tech",), matcher="nginx"), line("tech-detect", tags=("tech",), matcher="php"),
                     line("tech-detect", tags=("tech",), matcher="Microsoft ASP.NET"),
                     line("nginx-version", tags=("tech",), extracted=["nginx/1.30.6"]))
        self.assertEqual(sorted(f["value"] for f in found(run, "technology")),
                         ["microsoft-asp.net", "nginx/1.30.6", "php"])

    def test_generic_matcher_names_fall_back_to_the_template(self):
        run = parsed(line("apache-detect", tags=("tech",), matcher="version", extracted=["2.4.62"]))
        self.assertEqual([f["value"] for f in found(run, "technology")], ["apache/2.4.62"])

    def test_waf_and_cve_templates_stay_vulnerabilities(self):
        run = parsed(line("waf-detect", tags=("waf", "tech"), matcher="nginxgeneric", severity="info"),
                     line("CVE-2020-1", tags=("tech", "cve"), cves=["CVE-2020-0001"]))
        self.assertEqual(found(run, "technology"), [])
        self.assertEqual(sorted(f["value"] for f in found(run, "vulnerability")), ["CVE-2020-0001", "waf-detect"])

    def test_tech_extracted_values_are_not_masked(self):
        run = parsed(line("thing-detect", tags=("tech",), extracted=["12.4.1"]))
        self.assertEqual(found(run, "technology")[0]["data"]["extracted"], ["12.4.1"])


class UrlTest(unittest.TestCase):
    def test_matched_url_gets_its_own_node_under_the_target(self):
        run = parsed(line("git-config", matched_at=f"{BASE}/.git/config"),
                     line("other", matched_at=f"{BASE}/.git/config"))
        urls = found(run, "url")
        self.assertEqual(len(urls), 1)
        self.assertEqual((urls[0]["value"], urls[0]["parent"]["value"], urls[0]["relation"]),
                         (f"{BASE}/.git/config", TARGET, "has_url"))
        for f in found(run, "vulnerability"):
            self.assertEqual(f["parent"], {"type": "url", "value": f"{BASE}/.git/config"})

    def test_no_extra_node_at_the_target_itself(self):
        for matched in (BASE, f"{BASE}/", f"{BASE}:443/"):
            run = parsed(line("hdrs", matched_at=matched))
            self.assertEqual(found(run, "url"), [], matched)
            self.assertEqual(found(run, "vulnerability")[0]["parent"]["value"], TARGET)

    def test_another_host_is_ignored(self):
        run = parsed(line("git-config", matched_at="https://elsewhere.northwind.example/.git/config"))
        self.assertEqual((found(run), run.ignored), ([], 1))

    def test_dot_segments_hang_off_the_target(self):
        for path in ("/cgi-bin/.%2e/.%2e/etc/passwd", "/a/../etc/passwd", "/%2E%2E/x", "/./x"):
            run = parsed(line("CVE-x", matched_at=BASE + path, cves=["CVE-2021-41773"]))
            f = found(run, "vulnerability")[0]
            self.assertEqual((f["parent"]["value"], f["data"]["matched_at"]), (TARGET, BASE + path), path)
            self.assertEqual(found(run, "url"), [])
        self.assertFalse(nuclei.has_dot_segments(f"{BASE}/a.b/..x/.env"))

    def test_bad_lines_are_errors(self):
        run = parsed('{"info": {}}', "not json", line("ok"))
        self.assertEqual(len(found(run, "vulnerability")), 1)
        self.assertTrue(run.errors)


class LogTest(unittest.TestCase):
    DONE = "[INF] Templates loaded for current scan: 6516\n[INF] Scan completed in 37m. 19 matches found.\n"

    def errors(self, stderr):
        return parsed(line("t"), stderr=stderr).errors

    def test_completed_scan_and_replay_are_clean(self):
        self.assertEqual(self.errors(self.DONE), [])
        self.assertEqual(self.errors(None), [])

    def test_skipped_host_time_limit_and_no_templates_are_errors(self):
        skipped = self.DONE + ("[INF] Skipped lab.northwind.example:443 from target list as found unresponsive "
                               "permanently: cause=\"port closed or filtered\"\n")
        self.assertEqual(len(self.errors(skipped)), 1)
        self.assertIn("unresponsive", self.errors(skipped)[0])
        stopped = "[INF] Templates loaded for current scan: 6516\n[INF] CTRL+C pressed: Exiting\n"
        self.assertIn("time limit", self.errors(stopped)[0])
        self.assertIn("did not report", self.errors("[INF] Templates loaded for current scan: 6516\n")[0])
        self.assertIn("no templates", self.errors("[INF] Templates loaded for current scan: 0\n"
                                                  "[INF] Scan completed in 1ms. No results found.\n")[0])

    def test_only_the_targets_own_port_being_skipped_is_an_error(self):
        side = self.DONE + ("[INF] Skipped lab.northwind.example:5814 from target list as found unresponsive "
                            "permanently: cause=\"port closed or filtered\"\n")
        self.assertEqual(self.errors(side), [])
        own = self.DONE + "[INF] Skipped lab.northwind.example:443 from target list as found unresponsive permanently\n"
        self.assertEqual(len(self.errors(own)), 1)
        self.assertEqual(nuclei.target_hostport("http://Lab.northwind.example:8080/x"), "lab.northwind.example:8080")
        self.assertEqual(nuclei.target_hostport("http://[2001:db8::1]/"), "[2001:db8::1]:80")

    def test_an_incomplete_scan_with_findings_is_partial(self):
        run = parsed(line("t"), stderr="[INF] CTRL+C pressed: Exiting\n")
        self.assertEqual(run.result()["status"], "partial")


if __name__ == "__main__":
    unittest.main()
