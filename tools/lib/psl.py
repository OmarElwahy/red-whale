"""
Public Suffix List, standard library only (https://publicsuffix.org/list/, the algorithm at /list/#list-format).

    psl = PublicSuffixList.load("/opt/redwhale/dns/data/public_suffix_list.dat")
    psl.registrable("www.example.co.uk")            -> "example.co.uk"   (ICANN section only)
    psl.private_suffix("app.herokuapp.com")         -> "herokuapp.com"   (a name strictly below a PRIVATE rule)

The ICANN and PRIVATE sections are kept apart: `registrable()` uses only ICANN rules (what a registry sells, so what
RDAP knows about); `private_suffix()` uses both and reports the prevailing rule only when it is a PRIVATE one
(a cloud service's namespace, e.g. herokuapp.com, s3.amazonaws.com, github.io).

Rules: normal (`co.uk`), wildcard (`*.ck`: any label under ck is a suffix) and exception (`!www.ck`: www.ck is not
one, so www.ck is registrable). An exception wins over everything; otherwise the rule with the most labels; with no
match, the default rule `*` (the last label alone). Rules in Unicode are converted label by label to punycode,
because names reach us as ASCII (`xn--…`). The server's tldts gives the same answers: tools/lib/fixtures/
psl_vectors.json is checked against both (test_psl.py, shared/test/psl-parity.test.ts).
"""

ICANN = "icann"
PRIVATE = "private"


def to_ascii(name):
    """Lowercase, no trailing dot, each non-ASCII label as punycode (`xn--…`); ASCII labels are kept as they are."""
    labels = name.strip().rstrip(".").lower().split(".")
    return ".".join(lab if lab.isascii() else "xn--" + lab.encode("punycode").decode("ascii") for lab in labels)


class PublicSuffixList:
    def __init__(self, text):
        self.rules = {}       # "co.uk" -> section
        self.wildcards = {}   # "ck" for "*.ck" -> section
        self.exceptions = {}  # "www.ck" for "!www.ck" -> section
        section = None
        for line in text.splitlines():
            line = line.strip()
            if line.startswith("//"):
                if "===BEGIN ICANN DOMAINS===" in line:
                    section = ICANN
                elif "===BEGIN PRIVATE DOMAINS===" in line:
                    section = PRIVATE
                elif "===END ICANN DOMAINS===" in line or "===END PRIVATE DOMAINS===" in line:
                    section = None
                continue
            if not line or section is None:
                continue
            rule = line.split()[0]  # a rule ends at the first whitespace
            if rule.startswith("!"):
                self.exceptions[to_ascii(rule[1:])] = section
            elif rule.startswith("*."):
                self.wildcards[to_ascii(rule[2:])] = section
            else:
                self.rules[to_ascii(rule)] = section
        if not self.rules:
            raise ValueError("no rules found: not a Public Suffix List (no ===BEGIN ICANN DOMAINS=== section?)")

    @classmethod
    def load(cls, path):
        with open(path, encoding="utf-8") as fh:
            return cls(fh.read())

    def _suffix(self, labels, sections):
        """(public suffix as a label list, section of the prevailing rule or None for the default rule)."""
        n = len(labels)
        # An exception wins over every other rule; its suffix is the rule minus its first label.
        for i in range(n):
            sec = self.exceptions.get(".".join(labels[i:]))
            if sec in sections:
                return labels[i + 1:], sec
        # Otherwise the matching rule with the most labels (i = 0 is the longest candidate).
        for i in range(n):
            candidate = ".".join(labels[i:])
            sec = self.rules.get(candidate)
            if sec in sections:
                return labels[i:], sec
            if i + 1 < n:  # "*.X" matches this candidate when everything after its first label is X
                sec = self.wildcards.get(".".join(labels[i + 1:]))
                if sec in sections:
                    return labels[i:], sec
        return labels[-1:], None  # the default rule "*"

    def public_suffix(self, name, private=False):
        labels = to_ascii(name).split(".")
        suffix, _ = self._suffix(labels, (ICANN, PRIVATE) if private else (ICANN,))
        return ".".join(suffix)

    def registrable(self, name):
        """The registrable domain under the ICANN section (suffix + one label), or None if `name` is a suffix itself."""
        labels = to_ascii(name).split(".")
        if not all(labels):
            return None
        suffix, _ = self._suffix(labels, (ICANN,))
        if len(labels) <= len(suffix):
            return None
        return ".".join(labels[-(len(suffix) + 1):])

    def private_suffix(self, name):
        """The PRIVATE-section suffix `name` sits strictly below (e.g. "herokuapp.com"), else None."""
        labels = to_ascii(name).split(".")
        if not all(labels):
            return None
        suffix, sec = self._suffix(labels, (ICANN, PRIVATE))
        if sec != PRIVATE or len(labels) <= len(suffix):
            return None
        return ".".join(suffix)
