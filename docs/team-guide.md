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
| JSON lines, and it **talks to the target** (an active tool) | `tools/http/httpx/` |

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
by hand), `label`, `description`, `mode`, `accepts`, the script path inside `argv`, `timeoutSec`, `external` and
`contacts`. The real `tools/http/httpx/tool.json`:

```json
{
  "name": "httpx",
  "group": "http",
  "label": "httpx",
  "description": "ProjectDiscovery httpx: which of the host's HTTP(S) ports answer, with status, title, web server and technologies. Never follows redirects.",
  "mode": "active",
  "accepts": ["domain", "subdomain"],
  "argv": ["python3", "-I", "/opt/redwhale/http/httpx/run.py", "--target", "{target}", "--target-type", "{targetType}", "--out", "/out"],
  "timeoutSec": 300,
  "external": [],
  "contacts": "sends HTTP(S) requests to {target} on ports 80 and 443 (GET /, at most 5 per second; redirects are not followed)",
  "outputDir": "/out"
}
```

- `mode`: `passive` (only asks third-party sources, never touches the target), `active` (talks to the target),
  `intrusive` (could break or change something). If you're not sure, it's `active`. Active and intrusive runs only
  start after the analyst confirms them in a dialog, and only with passive-only mode off.
- `accepts`: the node types it can be pointed at: `domain`, `subdomain`, `ip`, `port`, `url`.
- `{target}` stays exactly like that, as its own item. Never build a command string.
- `{targetType}` (optional, at most once, its own item): the server replaces it with the target node's type
  (`domain`, `subdomain`…). Add `"--target-type", "{targetType}"` when your script names the target as a finding's
  `parent` (see `run.target_type` below). Never guess the type in Python: a wrong type makes a second, duplicate node.
- `external`: the outside services it contacts (shown in the UI).
- `contacts`: **required for `active` and `intrusive` tools** (optional for passive ones). One plain sentence saying
  what a run touches, with `{target}` where the target goes, e.g. `"sends HTTP(S) requests to {target} on ports 80 and
  443"`. The confirmation dialog shows it. `{target}` is the only placeholder allowed; it is display text, never part
  of the command.

**`run.py`**: change three things and nothing else:

```python
TOOL = "mytool"                                         # = name in tool.json
VERSION_COMMAND = ["/usr/local/bin/mytool", "-version"] # or None if the tool can't print its version

def build_command(target):
    # The exact command, as a list. Always use the tool's machine-readable output (JSON / XML).
    # Call the program by its absolute path in the image.
    return ["/usr/local/bin/mytool", "-u", target, "-json", "-silent"]

def parse(raw, run, target):
    # `raw` is everything the tool printed. Turn it into findings.
    for item in json_lines(raw, run):            # one JSON object per line; bad lines are reported for you
        ip = item.get("ip")
        if ip:
            # run.target_type: the target node's type, from --target-type (tool.json has "{targetType}")
            run.add("ip", ip, parent=(run.target_type, target))
        for tech in item.get("tech") or []:
            run.add("technology", tech_value(tech["name"], tech.get("version")), parent=("ip", ip))

if __name__ == "__main__":
    # needs_target_type=True: the script stops with an error if --target-type is missing (it never guesses)
    sys.exit(main(TOOL, parse, command=build_command, version_command=VERSION_COMMAND, needs_target_type=True))
```

A real one to read: `tools/http/httpx/run.py` (target → ip → port → url → technology).

The helper calls you'll use:

| Call | What it does |
|---|---|
| `run.add(type, value, parent=(type, value), severity=…, data={…})` | One finding. Values are cleaned (lowercase hosts, no trailing dot, IPv6 brackets…); invalid ones are skipped and reported; the same finding twice is merged; `relation` is filled in when only one fits |
| `run.add_subdomain(host, domain, data={…})` | A subdomain; skips wildcards, the domain itself and names outside it |
| `run.error("what went wrong")` | Records a problem: the result becomes `partial` (or `failed` with no findings) |
| `json_lines(raw, run)` | Each JSON line of the output |
| `port_value(ip, port, "tcp")`, `mask_secret(s)` | Build a `port` value; mask a secret (never output a real one) |
| `tech_value(name, version)` | A `technology` value, always spelled one way: lowercase, spaces → `-`, then `/version` if there is one. `tech_value("Microsoft ASP.NET", "4.0")` → `microsoft-asp.net/4.0`, `tech_value("Nginx", "1.30.6")` → `nginx/1.30.6`, `tech_value("PHP")` → `php`. Always use it for technologies, so two tools land on one node |
| `run.target_type` | The target node's type (`domain`, `subdomain`…), when tool.json passes `--target-type {targetType}` and `main(..., needs_target_type=True)`; use it for the target's `parent=(run.target_type, target)` |

You never write `result.json` yourself, never create IDs, and never put raw terminal text into findings.

## 3. Capture a real sample (your fixture)

Run your tool **for real, once**, against a target you are allowed to test, with **exactly the command in
`build_command`**, and save what it printed:

```bash
pnpm tools:build <group>                   # the team leader adds your tool to the group's Dockerfile first
docker run --rm redwhale-tools/<group>:<tag> /usr/local/bin/mytool -u <target> -json -silent > raw.jsonl
```

(Or run the tool on your own machine if it's installed; the output must be the same format.)

**Active tools: capture against the local lab**, never a real host you haven't been cleared for. `pnpm lab:up` starts
`lab.redwhale.test` on the tools network (see `lab/README.md`); run your container on that network:

```bash
pnpm lab:up
docker run --rm --network redwhale-tools redwhale-tools/<group>:<tag> python3 -I /opt/redwhale/<group>/<yourtool>/run.py --target lab.redwhale.test --target-type subdomain --out /tmp/out
```

and copy `/tmp/out/raw.txt` out (e.g. add `; cat /tmp/out/raw.txt` inside `sh -c '…'`, as `tools/http/httpx/fixtures/NOTE.md`
describes). Anonymize the lab like any host: `lab.redwhale.test` → `lab.northwind.example`, `172.29.250.10` →
`198.18.0.10`.

If your tool uses `{targetType}`, `pnpm tools:check` must know the fixture target's type: before the first `--update`,
create `fixtures/expected.json` with just `{"target": "lab.northwind.example", "target_type": "subdomain"}`; `--update`
keeps both.

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
  technologies through `tech_value(name, version)` (`name/version`, lowercase, one spelling).
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
