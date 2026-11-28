# wafw00f fixtures

Both files are real wafw00f 2.4.2 output, captured on 2026-11-24 against the RED WHALE local lab (`pnpm lab:up`, see
`lab/README.md`), inside the `redwhale-tools/http` image on the `redwhale-tools` network, as user 10001 with a
read-only root filesystem, by `run.py --target <url>`. The exact command `build_command` ran:

```
/opt/wafw00f/bin/wafw00f -r -o - -f json --no-colors -T 10 <url>
```

- **`raw.json`** (the fixture `pnpm tools:check wafw00f` replays): `https://lab.redwhale.test/waf/`, where the lab
  plays a WAF (`lab/nginx.conf`, `location = /waf/`): a query string with an attack-looking test string gets a 403
  with `<h1>403 Forbidden</h1>` and "Request forbidden by administrative rules." in its body. That is what wafw00f's
  **Shadow Daemon (Zecure)** signature (`plugins/shadowdaemon.py`) looks for, on the answer to its attack request,
  so wafw00f names it: technology `shadow-daemon`, manufacturer `Zecure`. No Shadow Daemon (or any real vendor's
  product or page) is in the lab: the 403 page names only the RED WHALE lab. 2 requests, both to the lab (its log).
- **`no-waf.json`** (used by `test_wafw00f.py`): `https://lab.redwhale.test/` (no WAF): `detected: false`, 7 requests.

**Anonymized:** `lab.redwhale.test` → `lab.northwind.example`. Nothing else was changed (the random parameter names
in `trigger_url` are as captured). Nothing is edited: the generic-detection and "site down" cases are unit tests.

`expected.json` is what `run.py --target https://lab.northwind.example/waf/ --replay fixtures/raw.json` must produce.
