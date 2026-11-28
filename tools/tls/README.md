# Tool group: TLS checks (`tls`)

Image `redwhale-tools/tls:<hash>` (`pnpm tools:build tls`). **Active**: testssl.sh makes TLS handshakes with the target
itself, so the server asks for `confirmActive` (the UI's "Run active scan" dialog), passive-only must be off, and the
target must be in scope.

| Tool | Version | Mode | Accepts | Contacts | External |
|---|---|---|---|---|---|
| `testssl` | testssl.sh v3.2.5 (2026-11-04) | active | url (`https://` only), port (TCP) | TLS handshakes with one address of the host, one HTTP GET | none |

## testssl

**Image:** GitHub's source archive of the `v3.2.5` tag, sha256-pinned (the release has no other asset and publishes no
checksum, so the hash is the one computed from the download; other bytes fail the build). It brings testssl's own
OpenSSL build (`bin/openssl.Linux.x86_64`, `1.0.2-bad`, with the old protocols and ciphers it needs to test for),
passed with `--openssl`; the base image's `/usr/bin/openssl` 3.5 is its second one (TLS 1.3). Debian packages at
exact versions: procps, bsdextrautils (hexdump), bind9-dnsutils (dig), gawk. **No curl, wget or socat** in the image.

Command (flags checked against `testssl.sh --help` of 3.2.5), as `run.py` builds it:

```
/opt/testssl/testssl.sh --openssl /opt/testssl/bin/openssl.Linux.x86_64 -p -s -S -U --jsonfile <tmp>/testssl.json --nodns min --ip one --warnings batch --color 0 --quiet --disable-rating --connect-timeout 10 --openssl-timeout 10 <target>
```

- **Target:** an `https://` url (testssl reads the host for SNI, the port, default 443, and the path for BREACH from
  it; an `http://` url is refused before testssl starts) or a TCP port `ip:port/tcp` (`ip:port` for testssl, `-6`
  for IPv6; no SNI and no hostname to check the certificate against).
- **Checks:** `-p` protocols (SSLv2 … TLS 1.3, ALPN), `-s` cipher categories (NULL, export, LOW, 3DES, obsoleted CBC,
  AEAD), `-S` server defaults and the certificate, `-U` known flaws: Heartbleed, CCS injection, Ticketbleed, ROBOT,
  secure renegotiation, CRIME, BREACH, POODLE, TLS_FALLBACK_SCSV, SWEET32, FREAK, DROWN, LOGJAM, BEAST, LUCKY13,
  Winshock, RC4. **Never** `-h` (HTTP headers), STARTTLS (`-t`), `-c` (client simulation), `-e/-E`, `--mx`, a proxy.
- **One address:** `--ip one` tests the first address the host's lookup returns. Behind a CDN or round-robin DNS **a
  later run may pick another address** (and see another certificate or configuration): the tested IP is in the
  certificate's and every vulnerability's data as `ip`.
- **Outside contact: none.** DNS only through the machine's resolver (`needs_resolvers=True`: with no nameserver
  the run is refused): `--nodns min` asks only the host's A and AAAA records (probed with a logging `dig`: no PTR,
  no CAA, no MX). `--phone-out` (CRL downloads, OCSP queries) is never passed, and the image has no download tool.
  DROWN's advice prints a censys.io search link: text only, nothing is fetched. The rest is TLS handshakes with that
  one address and port, plus HTTP GETs of the URL's path inside TLS (service detection, BREACH: 2 on the lab).
- **Time:** ~30–50 s against the lab; `timeoutSec` 900. A run stopped at the limit is `partial` and keeps what testssl
  had written (its JSON file is read even when unclosed).

Findings (url target; a port target *is* the port, and everything hangs off it):

```
ip --has_port--> ip:port/tcp --serves--> url                 the address and port testssl tested (httpx's chain: they merge)
ip:port/tcp --has_certificate--> certificate                 value: SHA-256 fingerprint, lowercase hex
url (or the port) --has_vulnerability--> vulnerability       every result of severity LOW or higher
```

- **certificate** data: `subject` (the CN; testssl gives no full subject), `sans` (list; wildcards kept as written:
  SANs as subdomain findings are a later phase), `issuer`, `not_before`/`not_after` (UTC, `YYYY-MM-DDTHH:MM:00Z`),
  `trusted` (testssl's chain of trust is OK), `ip`. A server with an RSA and an ECDSA certificate gives two.
- **vulnerability:** value = the CVE testssl names (the first; all of them in `data.cves`), else testssl's id
  (`cert_chain_of_trust`, `cipherlist_OBSOLETED`, … without ` <hostCert#N>`). Severity LOW/MEDIUM/HIGH/CRITICAL →
  low…critical. data: `id`, `finding`, `cwe`, `ip`, `certificate` (the fingerprint, when the result is about one of
  several certificates). OK, INFO and WARN results are not findings; raw.txt keeps testssl's whole JSON.
- **Port targets drop `cert_trust`:** without a hostname testssl compares the certificate with the IP and reports
  "does not match supplied URI" (HIGH), and warns itself that trust results are wrong for a bare IP.
- The url's host is not linked to the ip (`resolves_to`): that needs to know whether the host is a domain or a
  subdomain (the Public Suffix List, in the dns image). httpx and dnsx make that link; the port node is the same.
- **Failures** (`failed`, nothing but the scan ingested): "no TLS service on <host:port>" (plain HTTP or anything
  else on the port), "can't connect to <host:port>: closed, refused or filtered", "<host> did not resolve: no
  address through the system resolver", or testssl's own FATAL message.

`--checks protocols,defaults` (any subset of protocols, ciphers, defaults, vulnerabilities) narrows the run for the
e2e tests; it is never in `tool.json`.

Try it safely against the local lab (`lab/README.md`): `https://lab.redwhale.test/` (a self-signed certificate,
TLS 1.2 + 1.3, CBC ciphers: five LOW+ results), `172.29.250.10:443/tcp`, and `172.29.250.10:8080/tcp` (no TLS).

Fixtures: real lab captures (`testssl/fixtures/NOTE.md`); `pnpm tools:check testssl`.

**Updating testssl.sh:** pick the newest stable release at least two weeks old (not a `3.3dev` snapshot), download
`https://github.com/testssl/testssl.sh/archive/refs/tags/v<version>.tar.gz` into an empty folder, `sha256sum` it, put
the URL, hash and top folder (`testssl.sh-<version>`) in the Dockerfile, check the flags in its `--help`, rebuild
(`pnpm tools:build tls`), re-capture the fixtures, run the e2e (`REDWHALE_E2E_SLOW=1` too). If a pinned Debian
package version has left the repository, the build says so: bump it in the Dockerfile.
