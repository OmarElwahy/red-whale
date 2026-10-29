# RED WHALE: Master Project Specification, Feature List & Complete Tool Catalog

## 1. Project Overview
This project (RED WHALE) is a free, open-source reconnaissance framework that brings the most common passive and active recon tools into one local platform. Instead of running many separate tools and piecing together their outputs by hand, the user launches them from a single interface and sees every result on one interactive graph. Each node is something that was found, such as a domain, subdomain, IP, port, technology, or finding. The user can click a node to expand it, run another tool on it, and review it.

Tools that do the same job are grouped into short-lived containers that run, return their results, and are removed, so there is no setup and little resource use. Results from several tools are cross-checked and given confidence levels, and the graph stays organized by grouping and hiding low-value information.

To elevate analysis and reduce noise, RED WHALE integrates two specialized AI components and a continuous CVE monitor:
1. Local Validation & Scoring LLM: A lightweight, locally hosted LLM whose sole function is to validate raw outputs from running tools and assign a confidence/severity score with minimal latency so all data remains private.
2. JavaScript Analysis Agent: An advanced code-scanning agent (compatible with Claude Code, Codex, or specialized local code models) that inspects discovered JavaScript files for hidden endpoints, hardcoded secrets, DOM flaws, and logic findings.
3. Continuous CVE Monitor: Cross-references discovered technologies, CPEs, and IP/port fingerprints against vulnerability databases to flag known CVEs and public exploits.

Everything runs locally, so the user’s data stays private, and active scanning only starts after the user confirms they are authorized to test the target.

---

## 2. Complete Feature List for RED WHALE

### 2.1 Core
- One platform for passive and active recon.
- Interactive graph where you click a node to expand it, open its link, or run a tool on it.
- Multiple tools run in parallel, with all results merged in one place.
- Completely free, unlimited, open source, and self-hosted.
- Both a web UI and a CLI.

### 2.2 Containers and Tool Groups
- Tools that do the same job live in one container (one per group).
- Containers are built or pulled once, run per job, then removed, with cached images and an optional low-disk mode.
- Zero setup for the user, with pinned tool versions and a one-command update.
- CPU and memory limits per container, a limit on concurrent containers, and automatic cleanup of orphaned containers.
- Unprivileged containers with only the capabilities they need, and no Docker socket mounted inside.

Core Baseline Container Group Table:
- Subdomain enumeration: subfinder, amass, sublist3r, assetfinder
- DNS resolution and validation: dnsx, puredns
- Port scanning: nmap, masscan, naabu
- HTTP probing and tech detection: httpx, whatweb, wafw00f
- Content discovery: ffuf, feroxbuster, gobuster
- URLs and crawling: katana, gau, waybackurls
- Vulnerability checks: nuclei, nikto
- OSINT and emails: theHarvester
- TLS: testssl, sslscan
- Secrets: trufflehog, gitleaks

### 2.3 AI & Intelligent Analysis
- Local Validation & Scoring LLM:
  - Runs locally for maximum speed and zero external data leakage.
  - Validates tool outputs, filters false positives, and assigns a structured score to every finding.
- JavaScript Code Analysis Agent:
  - Integrates a code-analysis agent (e.g., Claude Code, Codex, or local LLM agent) to scan harvested `.js` files for hidden API routes, parameters, secrets, and client-side vulnerabilities.

### 2.4 CVE Monitor
- Automatically correlates detected software versions, service banners, and IPs against CVE feeds (NVD, CISA KEV, Shodan InternetDB, Nuclei CVE templates).
- Tracks CVSS severity, exploit availability, and alerts the user when new CVEs match existing nodes on the graph.

### 2.5 Privacy and Local-Only
- All data stored locally, with no telemetry.
- UI bound to localhost with a login.
- Tools that contact external services are clearly labeled.
- API keys for optional sources (Shodan, Censys, Chaos, VirusTotal, Hunter.io, etc.) stored locally. The tool is fully useful with none.

### 2.6 Run Modes
- Run any tool by itself.
- Build custom packages of tools.
- Presets by intrusiveness:
  - Low (passive only)
  - Mid (light active)
  - High (full active)
  - All
- Estimate of tools, time, and request volume shown before launching.
- Optional auto-run of next tools when new nodes appear, with depth and request budgets.
- Parallel job queue with a concurrency limit.
- Supports scheduled and periodic scans, screenshots, and reports.

### 2.7 Verification and Result Quality
- Several tools per job, with results cross-checked.
- Counting of independent sources, not just tools.
- Confidence levels on every node: Discovered, Corroborated, Verified.
- Automatic merging of duplicates, with all sources kept on the node.
- Wildcard DNS detection, CDN and WAF detection (wafw00f), and a second-signal rule before reporting vulnerabilities.

### 2.8 Dynamic, Uncluttered Graph
- Groups collapsed by default (for example “412 subdomains”).
- Low-value nodes hidden unless requested, and nodes ranked by importance.
- Focus mode that dims everything unrelated to the selected node.
- Filters by type, source, and confidence, plus search.
- Table view alongside the graph.
- Drag to rearrange nodes.

### 2.9 Manual Review Workflow
- Tag nodes as Interesting, Checked, or Ignored, and add notes.
- List of everything marked Interesting.
- Automatic prioritization that surfaces admin panels, exposed `.git`, old versions, and similar high-value findings.
- Provenance on every node: which tool found it, the exact command, the raw output, and the time.

### 2.10 Safety and Scope
- Scope guard: active tools only run after the user confirms authorization.
- Allowlist and denylist, with out-of-scope hits flagged and never scanned.
- Rate limiting and safe defaults with no destructive scripts.
- Detection of throttling or blocking, shown to the user.
- Audit log of every scan with timestamp and target.

### 2.11 Data, History, and Export
- Projects that can be saved and reopened.
- Scan history and diffing (“3 new subdomains since last run”).
- Reports as HTML, PDF, or Markdown, plus JSON, CSV, and GraphML export.

### 2.12 Extensibility and Testing
- Add new tools through a simple config file: command template, output parser, input and output node types.
- Built-in practice lab (`docker-compose` with deliberately vulnerable targets) for testing and demos.

---

## 3. Complete Tool Catalog & Functional Categories

### 3.1 Subdomain Enumeration
- subfinder: passive subdomain discovery from many public sources.
- assetfinder: finds domains and subdomains related to a target.
- findomain: fast passive subdomain finder.
- chaos: ProjectDiscovery’s subdomain dataset (optional API key).
- sublist3r: passive enumeration using search engines and public sources.
- amass (enum): passive and active enumeration with extra sources.
- github-subdomains: scrapes subdomains out of GitHub code.
- shosubgo: pulls subdomains from the Shodan API.
- Public sources (via curl): crt.sh, Wayback CDX, VirusTotal, HackerTarget, URLScan.io, CommonCrawl.
- ffuf: subdomain brute-forcing with a wordlist.

### 3.2 Subdomain Permutation and DNS Resolution
- alterx: generates permutations of known subdomains.
- dnsx: resolves candidates, keeps the live ones, and does reverse lookups on IP ranges.
- puredns: fast domain resolver and subdomain bruteforcing with wildcard filtering.

### 3.3 DNS Reconnaissance
- dig: queries DNS records (A, AAAA, MX, NS) and does PTR reverse lookups.
- dnsrecon: DNS enumeration, zone transfer (AXFR) checks, and misconfiguration checks.

### 3.4 IP, ASN and Organization Discovery
- asnmap: maps a domain or organization to its ASN and IP ranges.
- amass intel: finds assets by organization name, CIDR, or ASN.
- whois: domain ownership and network registration data.
- IP-to-domain APIs: VirusTotal, AlienVault OTX, and URLScan.io list IPs tied to a domain.

### 3.5 Live Host Probing and Fingerprinting
- httpx: probes hosts and ports for status, title, server, and technology. Also used for filtering, screenshots, and fuzzing across other groups.
- whatweb: next-generation web scanner identifying technologies.
- Aquatone (or httpx screenshot / gowitness): screenshots of live hosts.

### 3.6 WAF Detection
- wafw00f: the standard WAF fingerprinting tool.
- nmap scripts (`http-waf-detect`, `http-waf-fingerprint`): WAF detection through nmap.
- nuclei WAF templates: `waf-detect.yaml`, run through nuclei.

### 3.7 URL and Endpoint Collection
- katana: active crawler (also finds JS files).
- hakrawler: fast active crawler.
- crawley: lightweight web crawler.
- gau: passive URL collection from archives.
- waybackurls: URLs from the Wayback Machine.
- urlfinder: passive URL discovery.

### 3.8 URL Filtering and Processing
- gf: filters URLs by vulnerability pattern (uses the GFpattren pattern files).
- uro, urldedupe: remove duplicate and low-value URLs.
- anew: appends only new lines to a file.
- qsreplace: swaps parameter values for payloads.

### 3.9 Parameter, Directory and File Discovery
- arjun: finds hidden GET and POST parameters.
- dirsearch: directory and file brute-forcing.
- feroxbuster: fast recursive content discovery.
- gobuster: directory/file and DNS busting tool.
- ffuf: web fuzzer for directories, XSS, and LFI.

### 3.10 JavaScript Analysis & Secret Detection
- LinkFinder: extracts endpoints from JS files.
- SecretFinder: extracts secrets and tokens from JS files.
- nuclei (`http/exposures/`): scans JS files for exposures.
- trufflehog: searches repositories and files for high-entropy secrets and verified credentials.
- gitleaks: detects hardcoded secrets like passwords, API keys, and tokens.
- AI JS Agent: scans JS code for logic flaws, hidden endpoints, and secrets.

### 3.11 Vulnerability Scanners
- nuclei: template-based scanner, including DAST for XSS and SSRF. Also used for LFI, CORS, CVEs, and subdomain checks.
- nikto: web server scanner for dangerous files, outdated versions, and misconfigurations.
- wpscan: WordPress users, plugins, and themes.
- sqlmap: automated SQL injection testing.

### 3.12 Port and Network Scanning
- naabu: fast port scanner that hands off to nmap.
- nmap: full port and service scan.
- masscan: very fast, large-scale port scanning.

### 3.13 TLS / SSL Analysis
- testssl: checks service for TLS/SSL ciphers, protocols, and cryptographic flaws.
- sslscan: queries SSL/TLS services to discover supported cipher suites and certificates.

### 3.14 XSS Testing
- Gxss, kxss: find reflected parameters.
- xsschecker, airixss: check whether payloads are reflected.
- dalfox: XSS scanner with blind and WAF-bypass modes.
- bxss + xss.report: blind XSS callbacks.

### 3.15 LFI, CORS and Open Redirect
- LFI: nuclei, ffuf, and httpx with LFI payload lists.
- Corsy, CORScanner: CORS misconfiguration scanners.
- Open redirect: gf, qsreplace, and httpx with payloads from the loxs repo.

### 3.16 Subdomain Takeover and Git Exposure
- subzy: detects subdomain takeover candidates.
- can-i-take-over-xyz: fingerprint reference for manual verification.
- httpx (`/.git/config`): detects exposed `.git` folders.

### 3.17 SSRF
- SSRFmap: automated SSRF analysis.
- Interactsh: free, open-source out-of-band (OOB) callbacks for blind SSRF/XSS (replaces paid Burp Collaborator/oastify).
- nuclei SSRF templates + httpx: SSRF fuzzing.

### 3.18 OSINT, Emails and Internet-Wide Search
- theHarvester: emails, subdomains, and names from public sources.
- Recon-ng: recon framework (WHOIS, DNS, subdomains, TLS certificates).
- shodan (CLI/API + InternetDB): finds servers, IPs, ports, and CVEs by IP or certificate (`ssl.cert.subject.CN`) and other dorks.
- External/API-labeled sources: Hunter.io, DomainTools, Google dorks (`site:`, `ext:`).

### 3.19 Metadata Extraction
- exiftool: metadata from individual files (replaces Windows-only FOCA inside Linux containers by chaining crawler/downloader -> exiftool; FOCA reserved for optional external/Phase 2 support).

### 3.20 Leaked Credentials
- HIBP Pwned Passwords API: checks a password using k-anonymity.
- h8mail: email breach hunting.
- External breach-search APIs (labeled external, optional user keys): DeHashed, LeakCheck, Intelligence X, Leakpeek, BreachDirectory, DarkEntry, CrackStation.

### 3.21 Wordlists, Payloads & General CLI Utilities
- SecLists: directory, subdomain, and parameter wordlists.
- coffinxp repos: GFpattren, nuclei-templates, and XSS, LFI, SSRF, and WordPress payloads.
- CLI utilities: `curl`, `jq`, `grep`, `sed`, `awk`, `cut`, `sort`, `tee`, `xargs`.