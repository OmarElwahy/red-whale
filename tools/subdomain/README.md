# Tool group: subdomain enumeration

One image (`redwhale-tools/subdomain:<hash>`, built with `pnpm tools:build subdomain`) with four **passive** tools.
None of them resolves names or touches the target: they ask public sources what names exist under a domain.
From the graph: right-click a domain → **Run tool ▸** → **Run group: subdomain enumeration** (one job per tool, so a
subdomain several tools find becomes *corroborated*).

| Tool | Version | Output we parse | Contacts |
|---|---|---|---|
| `subfinder/` | v2.17.0 | JSON lines (`-oJ -cs`: every source per host) | crt.sh, AlienVault OTX, HackerTarget, Wayback, … (no API keys configured) |
| `assetfinder/` | v0.1.1 | text, one host per line (it has no JSON mode) | crt.sh, Cert Spotter, HackerTarget, ThreatCrowd, Wayback |
| `findomain/` | 10.0.1 | text (`-q`: hosts only; no JSON mode) | CertSpotter, crt.sh database, Sublist3r API, ThreatCrowd, AnubisDB, urlscan.io, ThreatMiner |
| `crtsh/` | (HTTP API) | crt.sh's JSON (`?q=%25.<domain>&output=json`), from Python, retried | crt.sh |

Every folder has the same layout (`tool.json`, `run.py`, `fixtures/raw.*`, `fixtures/expected.json`,
`fixtures/NOTE.md`); **subfinder is the reference to copy** (see `docs/team-guide.md`). Check a folder with
`pnpm tools:check <tool>`.

The `Dockerfile` pins the base image by digest and each release by sha256. Changing a pin: update the URL and the
checksum together, then `pnpm tools:build subdomain`.

## Later (not in this group yet)

- **amass**: slow and heavy; passive mode only, with its own timeout tuning
- **sublist3r**: unmaintained; several of its sources are gone
- **chaos** (ProjectDiscovery): needs an API key (secrets handling comes first)
- **shosubgo**: needs a Shodan API key
- **github-subdomains**: needs a GitHub token
- **ffuf** (DNS/vhost brute force): **active**, not passive; belongs in an active group behind passive-only mode
