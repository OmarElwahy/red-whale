# naabu fixture

`raw.jsonl` lines 1–3 are real naabu v2.7.0 output, captured on 2026-11-11 against the RED WHALE local lab
(`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/ports` image on the `redwhale-tools` network, as user
10001 with a read-only root filesystem and **no capabilities** (`--cap-drop ALL`), by `run.py --target
172.29.250.10`. The exact command `build_command` ran:

```
/usr/local/bin/naabu -host 172.29.250.10 -s c -Pn -tp 100 -rate 50 -c 10 -timeout 2s -retries 1 -j -silent -nc -duc -no-stdin
```

The capture had 3 lines (the lab's ports 80, 443 and 8080), all kept.

**Anonymized:** the lab's address `172.29.250.10` → `198.18.0.10`. Nothing else was changed (same fields, order and
timestamps).

**Edited lines:**

- Line 4: an exact copy of line 1 (merged into the same finding).
- Line 5: blank.

`expected.json` is what `run.py --target 198.18.0.10 --replay fixtures/raw.jsonl` must produce. naabu needs no
`--target-type`: it accepts only IPs, so the parent of every port is `("ip", target)`.
