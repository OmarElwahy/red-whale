# Team Guide: Writing a Tool Script

Your job: write a Python script that runs **one tool** and outputs JSON in the RED WHALE format.

## What your script must do

1. Run the tool with its **JSON/XML output option** (e.g. `subfinder -oJ`, `httpx -json`,
   `nuclei -jsonl`, `nmap -oX -`). Don't parse the normal terminal text.
2. Convert the tool's output into the format in `docs/contract.md`.
3. Save it to a file like `output/subfinder_example.com.json`.
4. Run the validator until it prints ✓:

```bash
python3 tools/validate_output.py output/subfinder_example.com.json
```

## Script template

Save as `tools/<toolname>_runner.py`:

```python
#!/usr/bin/env python3
import json, subprocess, sys
from datetime import datetime, timezone

TOOL = "subfinder"

def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def main(target):
    cmd = ["subfinder", "-d", target, "-oJ", "-silent"]
    started = now()
    errors, findings = [], []

    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
        if proc.returncode != 0:
            errors.append(proc.stderr.strip()[:500])
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            item = json.loads(line)
            host = item["host"].lower().rstrip(".")
            if host.startswith("*"):
                continue  # wildcards are not subdomains
            findings.append({
                "type": "subdomain",
                "value": host,
                "parent": {"type": "domain", "value": target.lower()},
                "relation": "has_subdomain",
                "data": {"source": item.get("source")},
            })
    except Exception as e:
        errors.append(str(e))

    status = "failed" if errors and not findings else ("partial" if errors else "success")
    result = {
        "contract_version": 1,
        "tool": TOOL,
        "target": target,
        "command": " ".join(cmd),
        "started_at": started,
        "finished_at": now(),
        "status": status,
        "errors": errors,
        "findings": findings,
    }
    print(json.dumps(result, indent=2))

if __name__ == "__main__":
    main(sys.argv[1])
```

Run it: `python3 tools/subfinder_runner.py example.com > output/subfinder_example.com.json`

## Rules

- Only use the node types and relations listed in `docs/contract.md`. Need a new one? Ask the team leader.
- Values must follow the formats in the contract (lowercase hosts, `ip:port/tcp` for ports, full URLs ...).
- Never put real passwords, tokens or keys in the output. Mask them: `AKIA****WXYZ`.
- Don't create IDs. Don't add fields outside `type`, `value`, `parent`, `relation`, `severity`, `data`.
- Only scan targets you are allowed to test (your own lab, or targets with written permission).

## What to hand in

1. Your script: `tools/<toolname>_runner.py`
2. One real output file that passes the validator, saved in `contract/examples/<toolname>.real.json`
3. Three lines in your message: the tool version, the exact command, and anything weird you noticed
