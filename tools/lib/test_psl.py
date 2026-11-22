"""Unit tests for psl.py, against the bundled list and the shared parity vectors (tldts checks the same file)."""

import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import psl  # noqa: E402

PSL_FILE = os.path.join(HERE, "..", "dns", "data", "public_suffix_list.dat")
VECTORS = os.path.join(HERE, "fixtures", "psl_vectors.json")

SMALL = """
// ===BEGIN ICANN DOMAINS===
com
co.uk
uk
*.ck
!www.ck
公司.cn
cn
// ===END ICANN DOMAINS===
// ===BEGIN PRIVATE DOMAINS===
herokuapp.com
*.cloud.example
// ===END PRIVATE DOMAINS===
outside.example
"""


class VectorTest(unittest.TestCase):
    def test_bundled_list_matches_the_vectors(self):
        lst = psl.PublicSuffixList.load(PSL_FILE)
        with open(VECTORS, encoding="utf-8") as fh:
            vectors = json.load(fh)["vectors"]
        self.assertGreater(len(vectors), 20)
        for v in vectors:
            with self.subTest(name=v["name"], why=v["why"]):
                self.assertEqual(lst.registrable(v["name"]), v["registrable"])
                self.assertEqual(lst.private_suffix(v["name"]), v["private_suffix"])


class RuleTest(unittest.TestCase):
    def setUp(self):
        self.lst = psl.PublicSuffixList(SMALL)

    def test_sections_are_kept_apart(self):
        self.assertEqual(self.lst.registrable("app.herokuapp.com"), "herokuapp.com")  # ICANN only
        self.assertEqual(self.lst.private_suffix("app.herokuapp.com"), "herokuapp.com")
        self.assertEqual(self.lst.public_suffix("app.herokuapp.com"), "com")
        self.assertEqual(self.lst.public_suffix("app.herokuapp.com", private=True), "herokuapp.com")

    def test_private_wildcard(self):
        self.assertEqual(self.lst.private_suffix("a.b.cloud.example"), "b.cloud.example")
        self.assertIsNone(self.lst.private_suffix("b.cloud.example"))

    def test_rules_outside_both_sections_are_ignored(self):
        self.assertEqual(self.lst.registrable("a.b.outside.example"), "outside.example")  # default rule, not a rule

    def test_wildcard_and_exception(self):
        self.assertIsNone(self.lst.registrable("foo.ck"))
        self.assertEqual(self.lst.registrable("x.foo.ck"), "x.foo.ck")
        self.assertEqual(self.lst.registrable("www.ck"), "www.ck")
        self.assertIsNone(self.lst.registrable("ck"))

    def test_unicode_rules_match_punycode_names(self):
        self.assertEqual(self.lst.registrable("a.b.xn--55qx5d.cn"), "b.xn--55qx5d.cn")
        self.assertEqual(self.lst.registrable("a.b.公司.cn"), "b.xn--55qx5d.cn")  # Unicode input is converted too

    def test_case_and_trailing_dot(self):
        self.assertEqual(self.lst.registrable("WWW.Example.CO.UK."), "example.co.uk")

    def test_empty_labels_are_not_names(self):
        self.assertIsNone(self.lst.registrable("a..co.uk"))
        self.assertIsNone(self.lst.private_suffix(".herokuapp.com"))

    def test_not_a_list(self):
        with self.assertRaises(ValueError):
            psl.PublicSuffixList("<html>rate limited</html>")


if __name__ == "__main__":
    unittest.main()
