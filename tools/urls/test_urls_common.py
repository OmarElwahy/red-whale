"""urls_common: the shared static list and URL spelling. Run: python -m unittest discover -s tools/urls"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from urls_common import STATIC_ARG, STATIC_EXTENSIONS, canonical_url  # noqa: E402


class StaticListTest(unittest.TestCase):
    def test_media_and_fonts_out_css_js_pdf_in(self):
        for ext in ("png", "jpg", "svg", "woff2", "mp4"):
            self.assertIn(ext, STATIC_EXTENSIONS)
        for ext in ("css", "js", "pdf", "html", "txt", "xml", "json"):
            self.assertNotIn(ext, STATIC_EXTENSIONS)
        self.assertEqual(STATIC_ARG.split(","), list(STATIC_EXTENSIONS))
        self.assertEqual(len(set(STATIC_EXTENSIONS)), len(STATIC_EXTENSIONS))


class CanonicalUrlTest(unittest.TestCase):
    def test_server_spelling(self):
        cases = {
            "HTTP://WWW.Northwind.Example:80": ("http://www.northwind.example/", "www.northwind.example"),
            "https://northwind.example:443/a?b=1#frag": ("https://northwind.example/a?b=1", "northwind.example"),
            "https://northwind.example:8443/x": ("https://northwind.example:8443/x", "northwind.example"),
            "http://northwind.example:443/": ("http://northwind.example:443/", "northwind.example"),
            "https://northwind.example./": ("https://northwind.example/", "northwind.example"),
            "https://northwind.example?q": ("https://northwind.example/?q", "northwind.example"),
            "http://[2001:db8::1]:8080/p": ("http://[2001:db8::1]:8080/p", "2001:db8::1"),
            "  https://northwind.example/Path/Case  ": ("https://northwind.example/Path/Case", "northwind.example"),
        }
        for raw, want in cases.items():
            self.assertEqual(canonical_url(raw), want, raw)

    def test_not_a_usable_url(self):
        for raw in (None, "", "northwind.example/x", "ftp://northwind.example/", "https://", "javascript:void(0)",
                    "https://northwind.example:99999/", "https://northwind.example:abc/",
                    "https://user:pw@northwind.example/", "mailto:a@northwind.example"):
            self.assertIsNone(canonical_url(raw), raw)


if __name__ == "__main__":
    unittest.main()
