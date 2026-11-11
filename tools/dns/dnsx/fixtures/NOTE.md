# dnsx fixture

`raw.jsonl` line 1 is real dnsx v1.3.1 output, captured on 2026-11-11 against the RED WHALE local lab
(`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/dns` image on the `redwhale-tools` network, as user
10001 with a read-only root filesystem and no capabilities, by `run.py --target lab.redwhale.test --target-type
subdomain`. The exact command `build_command` ran:

```
/usr/local/bin/dnsx -l lab.redwhale.test -a -aaaa -cname -j -silent -nc -duc -rl 10 -t 5 -retry 2 -r 127.0.0.11:53
```

(`-r` lists the container's own resolver from `/etc/resolv.conf`. On a machine without that file a real run is
refused, "no system resolver found; refusing to use public ones"; a replay doesn't check, and its command has no `-r`.)
The capture had 1 line, kept as is. Docker's DNS answers the lab's name with an A record only (`status_code` is
`NXDOMAIN` because the AAAA/CNAME questions have no answer).

**Anonymized:** `lab.redwhale.test` → `lab.northwind.example` (also inside `all`), the lab's address
`172.29.250.10` → `198.18.0.10` (in `a`, `all`, `internal_ips`). Nothing else was changed.

**Edited lines** (Docker's DNS gives no AAAA or CNAME answers, so the lab can't produce these):

- Line 2: line 1 with a made-up AAAA answer `2001:DB8:0:0::10` (stored canonical: `2001:db8::10`) and a CNAME
  `edge.northwind.example.` (trailing dot dropped), `status_code` `NOERROR`. Both ips get `data.cname`; the A answer
  is the same ip as line 1, so the two merge into one finding.
- Line 3: blank.
- Line 4: a made-up dangling CNAME (`gone.northwind.example`, no A/AAAA answer): no finding, not an error; the run
  only notes it in its log.

`expected.json` (with `"target_type": "subdomain"`, which `pnpm tools:check` passes as `--target-type`) is what
`run.py --target lab.northwind.example --target-type subdomain --replay fixtures/raw.jsonl` must produce. The target
itself is never a finding.
