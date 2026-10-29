## Project Overview

This project is a free, open-source reconnaissance framework that unifies the most common passive and active recon tools into a single, local platform. Instead of running fragmented command-line utilities and manually aggregating disparate outputs, security practitioners launch actions from a centralized interface and visualize discoveries on an interactive correlation graph. Every asset discovered—such as a domain, subdomain, IP address, open port, running technology, or security finding—is represented as a node. Users can interactively explore the attack surface by clicking any node to inspect details, expand relationships, or trigger contextual follow-up scans directly from it.

To keep resource overhead minimal and eliminate setup friction, tools serving similar functions are packaged into short-lived, isolated containers that spin up on demand, execute their tasks, stream structured data back to the core engine, and terminate. Findings across multiple tools are cross-correlated to prune duplicates and eliminate false positives, keeping the graph clean and actionable by collapsing low-priority artifacts.

To elevate analysis beyond raw enumeration, the framework incorporates two targeted AI layers:

- **Local Validation & Scoring Model:** A lightweight, self-hosted LLM runs locally for ultra-fast, zero-latency inference without sending sensitive recon telemetry off-machine. Its sole responsibility is to evaluate, validate, and assign a confidence/risk score to raw tool outputs, ensuring only high-fidelity signals populate the active graph.
- **Specialized JavaScript Analysis Agent:** A dedicated code-analysis agent (leveraging advanced reasoning models such as Claude Code, Codex, or equivalent specialized static-analysis engines) inspects harvested client-side JavaScript files. It automatically surfaces hidden API endpoints, sensitive hardcoded parameters, secrets, source map paths, and client-side logic flaws.

The entire environment operates strictly on local infrastructure, guaranteeing complete data sovereignty and privacy. Active network interactions and deep scans are strictly gated, executing only after the user explicitly validates authorized testing permissions against the scope.

# Complete Feature List: RED WHALE

### 1. Core

- **Unified Recon Platform:** One interface covering both passive and active reconnaissance workflows.
- **Interactive Graph:** Click any node to inspect details, open links, run targeted tools, or trigger chained scans.
- **Parallel Orchestration:** Run multiple tools simultaneously with automated result aggregation.
- **FOSS & Self-Hosted:** Free, unlimited, open-source, and strictly self-hosted.
- **Dual Interface:** Accessible via interactive Web UI and headless CLI.

### 2. Containers and Tool Groups

- **Group Isolation:** Tools serving the same purpose are grouped into a single container image per category.
- **Ephemeral Lifecycle:** Containers are pulled/built once, spin up per job, stream results, and terminate immediately with an optional low-disk mode.
- **Zero Configuration:** Pinned tool versions with single-command updates.
- **Resource & Security Hardening:** Strict per-container CPU/memory limits, concurrency caps, automatic orphan cleanup, unprivileged execution, and no mounted Docker sockets.

| **Group** | **Tools** |
| --- | --- |
| **Subdomain Enumeration** | `subfinder`, `amass`, `sublist3r`, `assetfinder` |
| **DNS Resolution & Validation** | `dnsx`, `puredns` |
| **Port Scanning** | `nmap`, `masscan`, `naabu` |
| **HTTP Probing & Tech Detection** | `httpx`, `whatweb`, `wafw00f` |
| **Content Discovery** | `ffuf`, `feroxbuster`, `gobuster` |
| **URLs & Crawling** | `katana`, `gau`, `waybackurls` |
| **Vulnerability Checks** | `nuclei`, `nikto` |
| **OSINT & Emails** | `theHarvester` |
| **TLS Analysis** | `testssl`, `sslscan` |
| **Secret Detection** | `trufflehog`, `gitleaks` |

### 3. AI & Intelligent Analysis

- **Local Validation & Scoring Model:**
    - Lightweight, self-hosted LLM running locally for near-instant inference without leaking telemetry.
    - Validates raw tool outputs and assigns dynamic confidence and severity scores to filter noise.
- **JavaScript Code Analysis Agent:**
    - Pluggable agent (e.g., Claude Code, Codex, or local specialized models) that inspects client-side JS files discovered during crawling.
    - Automatically identifies exposed secrets, hidden API endpoints, unhandled parameters, source map leaks, and potential DOM/client-side vulnerabilities.

### 4. Vulnerability & CVE Monitoring

- **Continuous CVE Monitoring:**
    - Continuously matches detected software, services, and version fingerprints against real-time CVE feeds (NVD, CISA KEV, GitHub Advisory Database).
    - Flags newly published vulnerabilities affecting previously mapped target assets.
- **Exploit & Severity Tracking:**
    - Evaluates CVSS base scores, EPSS (Exploit Prediction Scoring System) metrics, and known public exploit availability (PoCs) for detected CVEs.
- **Proactive Alerts:**
    - Sends immediate notifications (webhook/UI alert) when a critical or actively exploited CVE matches an active node on the target's attack surface.

### 5. Privacy and Local-Only Execution

- **Data Sovereignty:** All scan data, project graphs, and artifacts are stored strictly on the local filesystem with zero external telemetry.
- **Local Authentication:** Web UI binds to `localhost` by default, protected by local authentication.
- **External Call Transparency:** Explicitly labels any tool or optional query that touches third-party external networks.
- **Local Secrets Vault:** Optional third-party API keys (Shodan, Censys, SecurityTrails, etc.) are encrypted and kept locally; no API keys are required for core functionality.

### 6. Run Modes

- **Granular Execution:** Run single tools independently or compose custom workflow packages.
- **Intrusiveness Presets:**
    - *Low:* Pure passive reconnaissance.
    - *Mid:* Light active probing (DNS, non-intrusive HTTP validation).
    - *High:* Full active enumeration (port scanning, fuzzing, nuclei templates).
    - *All:* Complete automated chain.
- **Pre-Flight Estimation:** Visual summary of estimated runtime, tool count, and network request volume before launch.
- **Smart Auto-Chaining:** Automatically triggers downstream tools when specific node types appear (e.g., discovering an open port triggers `httpx`), regulated by depth and request budgets.
- **Queue Management & Scheduling:** Parallel job queue with concurrency throttling, scheduled/recurring scans, automated screenshots, and periodic re-scans.

### 7. Verification and Result Quality

- **Cross-Source Corroboration:** Compares findings across distinct engines and counts independent data sources.
- **Multi-Tier Confidence States:** Categorizes nodes as *Discovered*, *Corroborated*, or *Verified*.
- **Intelligent Deduplication:** Merges identical findings into a unified node while retaining provenance and metadata from all detecting tools.
- **Environmental Context:** Automatic wildcard DNS filtering, CDN/WAF detection via `wafw00f`, and a mandatory multi-signal rule before reporting high-impact vulnerabilities.

### 8. Dynamic, Uncluttered Graph

- **Smart Aggregation:** Auto-collapses large asset sets by default (e.g., `412 Subdomains`).
- **Signal-to-Noise Filtering:** Low-value nodes stay hidden unless toggled; nodes are visually ranked by severity/importance.
- **Focus Mode:** Dims disconnected or irrelevant nodes to spotlight the selected asset's attack path.
- **Exploration Controls:** Multi-attribute filtering (asset type, source tool, confidence level), full-text search, draggable physics, and an interactive synchronized table view alongside the graph.

### 9. Manual Review Workflow

- **Analyst Triage:** Tag nodes as *Interesting*, *Checked*, or *Ignored*, with inline markdown notes.
- **Target Highlights:** Dedicated dashboard view compiling all assets tagged as *Interesting*.
- **Heuristic Prioritization:** Automatically bubbles up high-value targets (admin panels, exposed `.git` directories, outdated services, sensitive config files).
- **Execution Provenance:** Complete audit trail on every node showing detecting tool, exact CLI command executed, timestamp, and full raw terminal output.

### 10. Safety and Scope

- **Scope Guard:** Hard gate requiring explicit user authorization confirmation before executing any active scan.
- **Strict Scope Boundary:** Enforces regex/CIDR allowlists and denylists; out-of-scope targets are flagged and blocked from downstream tools.
- **Safe Defaults:** Built-in rate limiting without destructive exploit payloads.
- **Adaptive Throttling:** Detects target rate-limiting, WAF bans, or packet drops and alerts the analyst.
- **Scan Auditing:** Immutable local audit log recording every scan execution, targeted host, and timestamp.

### 11. Data, History, and Export

- **Project Workspaces:** Save, export, and reopen isolated client or engagement workspaces.
- **Attack Surface Diffing:** Compare scan snapshots over time (e.g., identifying newly exposed ports or subdomains since the prior scan).
- **Flexible Export:** Generate formatted executive/technical reports in HTML, PDF, or Markdown, along with raw data exports in JSON, CSV, and GraphML.

### 12. Extensibility and Testing

- **Modular Plugin Engine:** Add new tools via declarative configuration files defining command templates, input/output node mappings, and output parsers.
- **Built-In Practice Lab:** Integrated `docker-compose` environment containing deliberately vulnerable services to validate toolchains, test parsers, and run offline demos.