# assetfinder fixture

`raw.txt` is real assetfinder v0.1.1 output (plain text, one host per line: assetfinder has no JSON mode), captured
on 2026-11-02 with the exact command the script runs (`assetfinder --subs-only <domain>`, inside the
`redwhale-tools/subdomain` image), against a bug-bounty target the team is authorized to test. All 27 lines are kept
(the first is the domain itself: assetfinder returns the apex too).

**Anonymized:** every hostname was rewritten to a fake one under `northwind.example`, with the same mapping as the
other subdomain tools' fixtures (so a host several tools found has the same fake name in each).

The real capture had no uppercase, trailing-dot, wildcard, duplicate, blank or out-of-domain lines, so the last 7
lines are **edited copies** of real lines that add those cases (`notnorthwind.example` stands for a suffix match
outside the domain, which `--subs-only` lets through).

`expected.json` is what `run.py --target northwind.example --replay fixtures/raw.txt` must produce.
