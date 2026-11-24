# testssl fixtures

Every file is a real testssl.sh 3.2.5 JSON file (`--jsonfile`, flat), captured on 2026-11-24 against the RED WHALE
local lab (`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/tls` image on the `redwhale-tools`
network, as user 10001 with a read-only root filesystem, by `run.py --target <target> --target-type <type>`. The
exact command `build_command` ran (the JSON path is a fresh temp folder each run):

```
/opt/testssl/testssl.sh --openssl /opt/testssl/bin/openssl.Linux.x86_64 -p -s -S -U --jsonfile /tmp/redwhale-testssl-<random>/testssl.json --nodns min --ip one --warnings batch --color 0 --quiet --disable-rating --connect-timeout 10 --openssl-timeout 10 <target>
```

- **`raw.json`** (the fixture `pnpm tools:check testssl` replays): `https://lab.redwhale.test/` (url). 80 results;
  the lab's self-signed certificate (CN and SANs `lab`/`elsewhere`, 825 days), TLS 1.2 + 1.3, CBC ciphers offered.
  LOW or higher: `cipherlist_OBSOLETED` (low), `cert_chain_of_trust` (critical, self signed), `cert_extlifeSpan`
  (medium), `cert_revocation` (high), `LUCKY13` (low, `CVE-2013-0169`). 49 s.
- **`port.json`** (unit tests): the same server as a port, `172.29.250.10:443/tcp` (no SNI): the same results plus
  `cmdline_ip-target` (WARN, "Target is not a server name") and `cert_trust` HIGH ("certificate does not match
  supplied URI"), which run.py drops for a port target.
- **`not-tls.json`**: `172.29.250.10:8080/tcp` (plain HTTP): `optimal_proto` "doesn't seem to be a TLS/SSL enabled
  server" (testssl exit 245).
- **`closed.json`**: `172.29.250.10:9/tcp` (nothing listens): `scanProblem` FATAL "Can't connect" (exit 246).
- **`no-address.json`**: `https://nothere.redwhale.test/` (a name the tools network can't resolve): `scanProblem`
  FATAL "couldn't identify supplied 'CMDLINE_IP'" (what `--ip one` says when the lookup returned nothing).

**Anonymized:** `lab.redwhale.test` → `lab.northwind.example`, `elsewhere.redwhale.test` →
`elsewhere.northwind.example`, `nothere.redwhale.test` → `nothere.northwind.example`, the lab's address
`172.29.250.10` → `198.18.0.10`. Nothing else was changed: the certificate's fingerprints, serial and PEM (`cert`)
are the lab's own (made when the lab image was built, so they differ on every machine; the PEM still encodes the lab's
real `redwhale.test` names). Nothing is edited; cases the lab can't produce (two certificates, several CVEs on one
result) are unit tests.

`expected.json` is what `run.py --target https://lab.northwind.example/ --target-type url --replay fixtures/raw.json`
must produce.
