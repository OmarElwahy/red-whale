# nmap fixtures

Two real nmap 7.95 (Debian `7.95+dfsg-3`) captures, taken on 2026-11-11 against the RED WHALE local lab
(`pnpm lab:up`, see `lab/README.md`), inside the `redwhale-tools/ports` image on the `redwhale-tools` network, as user
10001 with a read-only root filesystem, `no-new-privileges` and **no capabilities** (`--cap-drop ALL`), by `run.py`.

`pnpm tools:check` takes exactly one `raw.*` per tool, so:

| Mode | Raw | Expected | Checked by |
|---|---|---|---|
| ip | `raw.xml` | `expected.json` | `pnpm tools:check nmap` |
| port | `port/raw.xml` | `port/expected.json` | `test_nmap.py` (`FixtureTest`), which `tools:check` and `pnpm test` run |

## ip mode (`raw.xml`)

`run.py --target 172.29.250.10 --target-type ip`, which ran:

```
/usr/bin/nmap -sT -Pn -n -sV --unprivileged --noninteractive --max-rate 50 --max-retries 1 --host-timeout 480s --top-ports 100 -oX - 172.29.250.10
```

Open: 22 (the lab's fake banner: ssh, OpenSSH 9.6p1, "protocol 2.0"), 80, 443 (`tunnel="ssl"`) and 8080 (http,
nginx 1.30.6). The other 96 of the top 100 are closed (`<extraports state="closed">`): not findings.

## port mode (`port/raw.xml`)

`run.py --target 172.29.250.10:22/tcp --target-type port`, which ran:

```
/usr/bin/nmap -sT -Pn -n -sV --unprivileged --noninteractive --max-rate 50 --max-retries 1 --host-timeout 480s -p 22 -oX - 172.29.250.10
```

## Anonymized

The lab's address `172.29.250.10` → `198.18.0.10` everywhere (the `args` attribute, the comment, `<address>`). Nothing
else was changed: same elements, attributes, order and timestamps. No lines were edited or added; the cases a real
capture doesn't show (closed/filtered ports, a service guessed from the port number, a host timeout, another host,
malformed XML) are small inline documents in `test_nmap.py`.

`expected.json` / `port/expected.json` are what `run.py --replay` must produce for `198.18.0.10` (`--target-type ip`)
and `198.18.0.10:22/tcp` (`--target-type port`).
