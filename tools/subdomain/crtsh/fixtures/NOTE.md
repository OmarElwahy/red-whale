# crt.sh fixture

`raw.json` is a real crt.sh answer (`GET https://crt.sh/?q=%25.<domain>&output=json`, the exact request the script
makes, from inside the `redwhale-tools/subdomain` image) captured on 2026-11-02 for a bug-bounty target the team is
authorized to test. 40 of its 306 certificates are kept, chosen to cover every distinct name and the real edge cases
it had: wildcards, uppercase names, several names per certificate, a common name that isn't among the names, and
organization names ("<company>.com, Inc.") where a hostname is expected. Field names, order and formatting are
crt.sh's.

**Anonymized:** every hostname was rewritten to a fake one under `northwind.example` (same mapping as the other
subdomain tools' fixtures), and another real domain of the same company to `*-corp.example`. Certificate `id` and
`serial_number` were replaced by made-up values (the real ones lead straight to the real certificates). Issuer
names and dates are real (public CAs).

The last certificate is an **edited copy** that adds what the real answer lacked: a trailing dot, an email address
and a name in another domain.

`expected.json` is what `run.py --target northwind.example --replay fixtures/raw.json` must produce.
