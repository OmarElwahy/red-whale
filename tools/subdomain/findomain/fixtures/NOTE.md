# findomain fixture

`raw.txt` is real Findomain 10.0.1 output (`-q`: hosts only, one per line; Findomain has no JSON output), captured
on 2026-11-02 with the exact command the script runs (`findomain -t <domain> -q`, inside the
`redwhale-tools/subdomain` image), against a bug-bounty target the team is authorized to test. All 6 lines are kept
(one is the domain itself); Findomain's keyless sources knew few names for this target.

**Anonymized:** every hostname was rewritten to a fake one under `northwind.example`, with the same mapping as the
other subdomain tools' fixtures (so a host several tools found has the same fake name in each).

The real capture had no uppercase, trailing-dot, wildcard, duplicate, blank or other-domain lines, so the last 6
lines are **edited copies** of real lines that add those cases (`mail.alder-corp.example` stands for a name outside
the target domain).

`expected.json` is what `run.py --target northwind.example --replay fixtures/raw.txt` must produce.
