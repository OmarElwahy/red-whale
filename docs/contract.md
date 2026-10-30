# Tool Output Contract (v1)

Every tool script in RED WHALE prints or saves **one JSON object** in this format.
The server ingests these files and turns them into graph nodes and edges.

Check your output before handing it in:

```bash
python3 tools/validate_output.py my_output.json
```

---

## 1. Top-level object

```json
{
  "contract_version": 1,
  "tool": "subfinder",
  "tool_version": "2.6.6",
  "target": "example.com",
  "command": "subfinder -d example.com -oJ -silent",
  "started_at": "2026-10-29T10:00:00Z",
  "finished_at": "2026-10-29T10:01:12Z",
  "status": "success",
  "errors": [],
  "findings": [ ... ]
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `contract_version` | integer | yes | Always `1` for now |
| `tool` | string | yes | Lowercase tool name: `subfinder`, `nmap`, `httpx` ... |
| `tool_version` | string | no | Output of the tool's `--version` if easy to get |
| `target` | string | yes | What the tool was run against (domain, IP, CIDR, or URL) |
| `command` | string | yes | The exact command line that was executed |
| `started_at` | string | yes | ISO 8601 UTC, ending in `Z` |
| `finished_at` | string | yes | ISO 8601 UTC, ending in `Z`, not before `started_at` |
| `status` | string | yes | `success`, `partial`, or `failed` |
| `errors` | string[] | yes | Error messages; empty list if none |
| `findings` | object[] | yes | Empty list is allowed (e.g. nothing found, or failed) |

---

## 2. A finding

```json
{
  "type": "subdomain",
  "value": "api.example.com",
  "parent": { "type": "domain", "value": "example.com" },
  "relation": "has_subdomain",
  "severity": "info",
  "data": { "source": "crtsh" }
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `type` | string | yes | One of the node types in section 3 |
| `value` | string | yes | Formatted exactly as section 3 says |
| `parent` | object | no | `{ "type", "value" }` of the node this finding hangs off. Omit only for top-level targets |
| `relation` | string | if `parent` | One of the relations in section 4, and must match the parent/child types |
| `severity` | string | no | `info`, `low`, `medium`, `high`, `critical`. Use it for vulnerabilities, secrets and leaks |
| `data` | object | no | Anything tool-specific: titles, status codes, banners, CVE IDs, matched templates. Free-form, but must be valid JSON |

**Do not** add any other fields to a finding. Put extra details inside `data`.
**Do not** create IDs. The server generates them.
**Do not** put raw terminal output in `findings`. If you want to keep it, put it in `data.raw` (keep it short).

---

## 3. Node types and value format

| `type` | `value` format | Example |
|---|---|---|
| `domain` | Lowercase registrable domain, no scheme, no trailing dot | `example.com` |
| `subdomain` | Lowercase FQDN, no scheme, no port, no trailing dot | `api.example.com` |
| `ip` | IPv4 or IPv6, no port | `93.184.216.34` |
| `port` | `ip:port/protocol`, protocol is `tcp` or `udp`. IPv6 goes in brackets | `93.184.216.34:443/tcp`, `[2001:db8::1]:443/tcp` |
| `url` | Full `http`/`https` URL; host lowercase ASCII, no `%`, and must parse as a URL (no spaces, port ≤ 65535) | `https://api.example.com/v1/login` |
| `technology` | `name` or `name/version` | `nginx/1.18.0` |
| `vulnerability` | Template/check ID or CVE ID (write CVE IDs in uppercase) | `CVE-2021-41773` |
| `email` | Lowercase email address | `admin@example.com` |
| `secret` | Short description, never the full secret | `AWS access key in /static/app.js` |
| `certificate` | SHA-256 fingerprint, lowercase hex | `3a7bd3e2...` |
| `leak` | Breach or source name | `LinkedIn-2016` |

Wildcard entries like `*.example.com` are **not** subdomains. Skip them or put them in `data`.

**Hostnames are ASCII.** Internationalized names in `domain`, `subdomain` and URL hosts must be sent as punycode
(`xn--…`); otherwise the validator says `non-ASCII host: convert it to punycode, e.g. host.encode('idna').decode()`.
A URL path may contain any characters.

**How the server treats values** (so you know what merges):
- `port` on IPv6: unbracketed input (`2001:db8::1:443/tcp`) is accepted and stored bracketed (`[2001:db8::1]:443/tcp`).
  `::ffff:1.2.3.4` is stored as `1.2.3.4`.
- `technology` is matched without case (`Nginx/1.18.0` and `nginx/1.18.0` are one node; the first spelling is the label).
  Put the version after a `/`, not in a separate finding.
- `vulnerability` CVE IDs are uppercased (`cve-2021-41773` → `CVE-2021-41773`); other IDs are kept as-is.
- A node you only name as a `parent` is recorded, but it does not count as your tool finding it. To count, report it
  as a finding of its own.

**Secrets:** never put a full secret, password, or token in `value` or `data`. Store a masked
preview at most, e.g. `"preview": "AKIA****WXYZ"`.

---

## 4. Relations

| `relation` | parent type → child type |
|---|---|
| `has_subdomain` | `domain` → `subdomain` |
| `resolves_to` | `domain` / `subdomain` → `ip` |
| `has_port` | `ip` → `port` |
| `serves` | `port` / `subdomain` / `domain` → `url` |
| `has_url` | `url` → `url` (crawled / discovered paths) |
| `uses_technology` | `url` / `port` → `technology` |
| `has_vulnerability` | `url` / `port` / `technology` / `subdomain` / `ip` → `vulnerability` |
| `has_certificate` | `port` / `subdomain` → `certificate` |
| `has_email` | `domain` / `subdomain` / `url` → `email` |
| `has_secret` | `url` → `secret` |
| `found_in_leak` | `email` → `leak` |

If your tool finds something that doesn't fit this table, **ask the team leader**. Don't invent new types or relations.

---

## 5. Full examples

See `contract/examples/` for complete files:
- `subfinder.example.json`
- `nmap.example.json`
- `httpx.example.json`
- `nuclei.example.json`

---

## 6. Changing the contract

Only the team leader changes this file. Every change updates, together: this doc,
`shared/` Zod schemas, `tools/validate_output.py`, and `contract/examples/`. Bump `contract_version`
for breaking changes.
