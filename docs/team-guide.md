# How to add your tool

You write a small Python script that runs **one tool** and turns its output into RED WHALE's JSON format
(`docs/contract.md`). The server runs it inside a Docker container, puts the result into the graph, and keeps the
tool's raw output. The four subdomain tools in `tools/subdomain/` are working examples; **copy one of them**.

Everything that is the same for every tool (arguments, running the tool, timeouts, saving the output, cleaning values,
skipping duplicates, validating) is already done by `tools/lib/redwhale_tool.py`. Your script is only:

1. the command to run, and
2. how to read its output.

## 1. Copy a tool folder

Pick the example closest to your tool:

| Your tool prints… | Copy |
|---|---|
| JSON lines / JSON (most tools: `-json`, `-oJ`, `-jsonl`) | `tools/subdomain/subfinder/` |
| plain text, one item per line (only if it has no JSON mode) | `tools/subdomain/assetfinder/` |
| nothing: it's a web API you call | `tools/subdomain/crtsh/` |

Your tool goes in its **group's** folder (ask the team leader which group, e.g. `ports`, `http`, `vulns`). If the group
doesn't exist yet, the team leader creates it (`group.json` + `Dockerfile`).

```
tools/<group>/<yourtool>/
  tool.json        what the server needs to know
  run.py           the command + the parser
  fixtures/
    raw.<ext>      one saved real output of your tool  (raw.jsonl, raw.txt, raw.json, raw.xml…)
    expected.json  what your parser must produce from it  (generated, then you check it)
    NOTE.md        where the sample came from
  test_<tool>.py   optional: unit tests for tricky parts (e.g. retries)
```

## 2. Change what's yours

**`tool.json`**: change `name` (= the folder name, lowercase; not `manual`, which is reserved for nodes the analyst adds
by hand), `label`, `description`, `mode`, `accepts`, the script path inside `argv`, `timeoutSec` and `external`:

```json
{
  "name": "httpx",
  "group": "http",
  "label": "httpx",
  "description": "ProjectDiscovery httpx: which hosts answer over HTTP(S), with title, status and tech.",
  "mode": "active",
  "accepts": ["subdomain", "domain"],
  "argv": ["python3", "-I", "/opt/redwhale/http/httpx/run.py", "--target", "{target}", "--out", "/out"],
  "timeoutSec": 600,
  "external": [],
  "outputDir": "/out"
}
```

- `mode`: `passive` (only asks third-party sources, never touches the target), `active` (talks to the target),
  `intrusive` (could break or change something). If you're not sure, it's `active`.
- `accepts`: the node types it can be pointed at: `domain`, `subdomain`, `ip`, `port`, `url`.
- `{target}` stays exactly like that, as its own item. Never build a command string.
- `external`: the outside services it contacts (shown in the UI).

**`run.py`**: change three things and nothing else:

```python
TOOL = "httpx"                                   # = name in tool.json
VERSION_COMMAND = ["httpx", "-version"]          # or None if the tool can't print its version

def build_command(target):
    # The exact command, as a list. Always use the tool's machine-readable output (JSON / XML).
    return ["httpx", "-u", target, "-json", "-silent"]

def parse(raw, run, target):
    # `raw` is everything the tool printed. Turn it into findings.
    for item in json_lines(raw, run):            # one JSON object per line; bad lines are reported for you
        url = item.get("url")
        if url:
            run.add("url", url, parent=("subdomain", target), data={"status": item.get("status_code")})
```

The helper calls you'll use:

| Call | What it does |
|---|---|
| `run.add(type, value, parent=(type, value), severity=…, data={…})` | One finding. Values are cleaned (lowercase hosts, no trailing dot, IPv6 brackets…); invalid ones are skipped and reported; the same finding twice is merged; `relation` is filled in when only one fits |
| `run.add_subdomain(host, domain, data={…})` | A subdomain; skips wildcards, the domain itself and names outside it |
| `run.error("what went wrong")` | Records a problem: the result becomes `partial` (or `failed` with no findings) |
| `json_lines(raw, run)` | Each JSON line of the output |
| `port_value(ip, port, "tcp")`, `mask_secret(s)` | Build a `port` value; mask a secret (never output a real one) |

You never write `result.json` yourself, never create IDs, and never put raw terminal text into findings.

## 3. Capture a real sample (your fixture)

Run your tool **for real, once**, against a target you are allowed to test, with **exactly the command in
`build_command`**, and save what it printed:

```bash
pnpm tools:build <group>                   # the team leader adds your tool to the group's Dockerfile first
docker run --rm redwhale-tools/<group>:<tag> httpx -u <target> -json -silent > raw.jsonl
```

(Or run the tool on your own machine if it's installed; the output must be the same format.)

The repo is **public**: before it goes in `fixtures/`, rewrite every real hostname, IP and identifier to fake ones,
consistently (the same real name always becomes the same fake name): hosts under `northwind.example`, IPs from
`198.18.0.0/15`, emails `@northwind.example`. Keep the format byte for byte otherwise (same fields, same order, same
spacing). Keep enough lines to cover the odd cases (empty results, errors, duplicates, wildcards, uppercase…); if the
real output had none, add a few edited copies and say so in `NOTE.md`. `NOTE.md` says: tool version, date, the exact
command, how many lines you kept, what you anonymized, which lines are edited.

Then create `expected.json` from your parser and **read it**: it is what your parser will be held to.

```bash
pnpm tools:check <yourtool> --update
```

## 4. Check it

```bash
pnpm tools:check <yourtool>
```

```
✓ tool definitions: 5 tools in 2 group(s) load as the server loads them
httpx  (tools/http/httpx)
  ✓ tool.json, run.py, fixtures/raw + NOTE.md present
  ✓ run.py --replay fixtures/raw.jsonl wrote result.json (12 findings)
  ✓ result.json follows the contract
  ✓ matches fixtures/expected.json (12 findings)

✓ all 1 passed
```

Every ✗ line says what's wrong (e.g. `missing finding  url https://api.northwind.example/` after you changed the
parser). Fix until everything is ✓. `pnpm test` runs the same checks for every tool.

You can also run your script by hand, on your laptop, exactly as the container does:

```bash
python tools/<group>/<tool>/run.py --target northwind.example --out out/ --replay tools/<group>/<tool>/fixtures/raw.jsonl
python tools/<group>/<tool>/run.py --target <a target you may test> --out out/      # runs the real tool
```

It writes `out/raw.txt` (what the tool printed) and `out/result.json` (the contract JSON).

## Rules

- Only node types and relations from `docs/contract.md`. Need another? Ask the team leader.
- Machine-readable output only (JSON, JSONL, XML). Parse text only when the tool has nothing else.
- Hosts are lowercase ASCII (punycode: `host.encode('idna').decode()`); IPv6 ports in brackets; CVE IDs uppercase;
  technologies `name/version`.
- Naming a node only as a `parent` doesn't count as your tool finding it; report it as a finding too if it did.
- Never output real passwords, tokens or keys: `mask_secret()`.
- Never commit real hostnames, IPs or customer data: fixtures are anonymized.
- Only run tools against targets you are allowed to test. In RED WHALE, the scope guard decides that for every run.

## What to send the team leader

1. Your folder `tools/<group>/<yourtool>/`, with `pnpm tools:check <yourtool>` all ✓.
2. For the Dockerfile: the tool's release URL (linux amd64), its version, and the archive's sha256
   (from the release's checksums file if it has one, else `sha256sum` of what you downloaded).
3. Three lines in your message: anything weird about the tool's output, which sources/keys it needs, and how long a
   normal run takes.
