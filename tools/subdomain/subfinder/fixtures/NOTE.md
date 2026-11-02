# subfinder fixture

`raw.jsonl` is real subfinder v2.17.0 output, captured on 2026-11-02 with the exact command the script runs
(`subfinder -d <domain> -oJ -cs -silent -duc -max-time 8`, inside the `redwhale-tools/subdomain` image), against a
bug-bounty target the team is authorized to test. 50 of its 550 lines are kept.

**Anonymized:** every hostname was rewritten to a fake one under `northwind.example`, with one consistent mapping
(common labels like `www`, `api`, `mail`, `dev` kept; other labels replaced by made-up words). The line format,
field names and source names are exactly as subfinder wrote them.

The real capture had no wildcard, uppercase, trailing-dot, duplicate or apex lines, so the last 8 lines are
**edited copies** of real lines that add those cases (an uppercase host, a trailing dot, two wildcards, the apex,
an exact duplicate, the same host from another source, a blank line).

`expected.json` is what `run.py --target northwind.example --replay fixtures/raw.jsonl` must produce.
