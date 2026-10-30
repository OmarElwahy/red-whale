# Team Guide: Writing a Tool Script

Your job: write a Python script that runs **one tool** and outputs JSON in the RED WHALE format
(`docs/contract.md`). You don't write that JSON by hand: the template and `tools/redwhale.py` do it.
You only decide **the exact command** and **how to read the tool's output**.

Needs Python 3.9+ and nothing else (no pip installs). On Windows use `py` instead of `python3`.

## Files you get

| File | What it is |
|---|---|
| `tools/TEMPLATE_runner.py` | Copy this. It has 3 TODO sections; everything else is done. |
| `tools/example_subfinder_runner.py` | The template filled in for subfinder. Read it next to the template. |
| `tools/redwhale.py` | Shared helper. Don't edit it; ask the team leader if it's missing something. |
| `tools/validate_output.py` | Checks a file against the contract. Your runner runs it automatically. |
| `tools/samples/` | Saved raw tool outputs, for testing parsers without running the tool. |

## Step by step

1. **Copy the template** to `tools/<toolname>_runner.py`, e.g. `tools/httpx_runner.py`.
2. **TODO 1:** set `TOOL` (lowercase) and the command that prints the tool's version.
3. **TODO 2:** put the exact command your team agreed on in `build_command(target)`, as a list of
   arguments. Always use the tool's **machine-readable output** (`-json`, `-jsonl`, `-oJ`, `-oX -` ...),
   never the coloured terminal text.
4. **Save a real raw output** once (run the tool by hand, redirect to a file) into
   `tools/samples/<toolname>.<ext>`. Now you can test your parser offline, as many times as you want:
   ```bash
   python3 tools/httpx_runner.py example.com --replay tools/samples/httpx.jsonl -o -
   ```
5. **TODO 3:** write `parse(output, run, target)`. For every thing the tool found, call:
   ```python
   run.add(type, value, parent=(parent_type, parent_value), severity=..., data={...})
   ```
   Examples:
   ```python
   run.add("subdomain", "api.example.com", parent=("domain", "example.com"), data={"source": "crtsh"})
   run.add("ip", "93.184.216.34", parent=("subdomain", "api.example.com"))
   run.add("port", port_value("93.184.216.34", 443), parent=("ip", "93.184.216.34"),
           data={"service": "https", "product": "nginx"})
   run.add("url", "https://api.example.com/", parent=("subdomain", "api.example.com"),
           data={"status_code": 200, "title": "API"})
   run.add("technology", "nginx/1.18.0", parent=("url", "https://api.example.com/"))
   run.add("vulnerability", "CVE-2021-41773", parent=("url", "https://api.example.com/"),
           severity="high", data={"template_id": "CVE-2021-41773"})
   run.add("secret", "AWS key in /static/app.js", parent=("url", "https://api.example.com/static/app.js"),
           severity="high", data={"preview": mask_secret(raw_key)})
   ```
   Pick types and parents from the tables in `docs/contract.md` (sections 3 and 4).
6. **Run it for real**, only against targets you are allowed to test:
   ```bash
   python3 tools/httpx_runner.py api.example.com
   ```
   It writes `output/httpx_api.example.com.json` and validates it. **✓ = done.**
   On a Windows console the ✓ may show as `?`; what matters is the line has no `ERROR`.

## What the helper does for you

- Fills in `contract_version`, `tool`, `tool_version`, `target`, `command`, `started_at`,
  `finished_at`, `status` and `errors`.
- Cleans values: lowercases hosts, emails and URL hosts; strips trailing dots and URL `#fragments`;
  compresses IPs; builds `ip:port/proto` with `port_value()`.
- Skips wildcards (`*.example.com`), empty values and invalid values. Each skipped finding is printed,
  and the run's status becomes `partial` with a note in `errors`.
- Fills in `relation` when only one relation fits the parent and child types.
- Merges duplicate findings (same type, value and parent): `data` is combined, highest severity kept.
- Records problems instead of crashing: tool not installed, non-zero exit, timeout, even a bug in
  your `parse()`. You still get a valid file whose `errors` says what went wrong.

Status is set automatically: `success` (no errors), `partial` (errors but some findings), `failed`
(errors and no findings). If something went wrong that the helper can't see, call `run.error("...")`.

## Rules

- Only use the node types and relations in `docs/contract.md`. Need a new one? Ask the team leader.
- Never put real passwords, tokens or keys in the output. Use `mask_secret()`.
- Don't create IDs, and don't add fields to findings. Extra details go in `data`.
- If you want to keep raw tool text, put a short piece in `data["raw"]`.
- Only scan targets you are allowed to test (your own lab, or targets with written permission).

## What to hand in

1. Your script: `tools/<toolname>_runner.py`
2. The raw sample you tested with: `tools/samples/<toolname>.<ext>`
3. One real output file that passes the validator: `contract/examples/<toolname>.real.json`
4. Three lines in your message: the tool version, the exact command, and anything odd you noticed
