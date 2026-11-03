# httpx fixture

`raw.jsonl` lines 1–2 are real httpx v1.12.0 output, captured on 2026-11-03 against the RED WHALE local lab
(`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/http` image on the `redwhale-tools` network, as
user 10001 with a read-only root filesystem, by `run.py --target lab.redwhale.test --target-type subdomain`. The
exact command `build_command` ran:

```
/usr/local/bin/httpx -u lab.redwhale.test -p http:80,https:443 -nf -j -silent -nc -no-stdin -duc -sc -title -server -td -ip -location -rl 5 -t 5 -timeout 10 -retries 1 -r 127.0.0.11:53
```

(`-r` lists the container's own resolver from `/etc/resolv.conf`; run on a machine without that file, the command
has no `-r`.) The capture had 2 lines; both are kept.

- Line 1: `http://…:80` answers `301` with `Location: https://elsewhere.…/` (the lab's redirect to another host). It
  was not followed: there is no line for the other host, and the lab's log showed no request for it.
- Line 2: `https://…:443`, `200`, title `Northwind Lab`.

**Anonymized:** `lab.redwhale.test` → `lab.northwind.example`, `elsewhere.redwhale.test` →
`elsewhere.northwind.example`, the lab's address `172.29.250.10` → `198.18.0.10`. Nothing else was changed (same
fields, order and spacing; timestamps and timings as captured).

**Edited lines** (the lab can't produce these cases):

- Line 3: an exact copy of line 2 (merged into the same findings).
- Line 4: blank.
- Line 5: a made-up answer on port 8443 with no `host_ip`/`a` (the url then hangs off the target with `serves`),
  status 403, and technologies `Microsoft ASP.NET` (no version, spaces), `IIS:10.0`, `Bootstrap:5.3.0`
  (spelled by `tech_value`: `microsoft-asp.net`, `iis/10.0`, `bootstrap/5.3.0`).
- Line 6: a made-up failed probe on port 8080 (`"failed":true`): skipped, not an error.

`expected.json` (with `"target_type": "subdomain"`, which `pnpm tools:check` passes as `--target-type`) is what
`run.py --target lab.northwind.example --target-type subdomain --replay fixtures/raw.jsonl` must produce.
