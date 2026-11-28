#!/usr/bin/env python3
"""
takeover-check -> RED WHALE contract v1 (docs/contract.md). Passive: it asks the system DNS resolver, RDAP servers
(IANA's bootstrap, bundled) and, for TLDs without RDAP, WHOIS servers. It never contacts the target or the names in
its CNAME chain.

    python run.py --target shop.northwind.example --target-type subdomain --out out/ --replay fixtures/raw.json
    python run.py --target <a subdomain> --target-type subdomain --out out/       real lookups

What it does:
1. Follows the target's CNAME chain hop by hop with dnsx (the system resolver only; at most MAX_HOPS hops; a loop
   stops it), recording each name's rcode (NOERROR, NXDOMAIN, SERVFAIL, REFUSED).
2. Finds each chain name's registrable domain (Public Suffix List, ICANN section; tools/lib/psl.py) and looks up the
   registration of the target's own registrable domain and of every other one in the chain: RDAP (200 registered,
   404 not registered, anything else unknown), or WHOIS when the TLD has no RDAP service (an expiry date, or
   unknown; WHOIS never says "not registered"). A name under a PSL private suffix (x.herokuapp.com) is a cloud
   service's name: it gets `service`, and its domain is not looked up.
3. Reports the chain, the registrations, and two vulnerabilities on the target:
   takeover-unregistered-domain (critical): a chain name's registrable domain is not registered (RDAP 404);
   takeover-dangling-cname (medium): a chain name outside the target's own domain is NXDOMAIN, and its domain is
   registered or it is a cloud service's name.
   The target itself is never a finding (6C-3); its own registrable domain is (the registration record is evidence).

Every DNS, RDAP and WHOIS exchange goes into a transcript (raw.txt). Findings are always built by replaying the
transcript through the same investigate() as the live run, so `--replay` gives exactly what the run gave, with no
network. The transcript also keeps the RDAP bootstrap entries the run used, so a refreshed bootstrap doesn't change
an old run's replay.
"""

import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[2] / "lib"))
from psl import PublicSuffixList  # noqa: E402
from redwhale_tool import clean_host, contract, log, main, now, resolver_args  # noqa: E402

TOOL = "takeover-check"
DNSX = "/usr/local/bin/dnsx"    # absolute: never whatever else is called dnsx on PATH
WHOIS = "/usr/bin/whois"        # Debian's whois package, pinned in tools/dns/Dockerfile
VERSION_COMMAND = None          # several programs and services; their versions are in the transcript's data
DATA_DIR = HERE.parents[1] / "data"
PSL_FILE = DATA_DIR / "public_suffix_list.dat"
BOOTSTRAP_FILE = DATA_DIR / "dns.json"

TRANSCRIPT_VERSION = 1
MAX_HOPS = 10                   # CNAME edges followed; one more is an error
RCODES = "noerror,nxdomain,servfail,refused"
DNSX_SECONDS = 30               # one dnsx process
RDAP_SECONDS = 10               # one RDAP request
WHOIS_SECONDS = 20              # one whois process
TRIES = 3                       # 1 + 2 retries (RDAP)
BACKOFF_SECONDS = [2, 5]        # before try 2, try 3
PER_SERVER_SECONDS = 1.0        # at most 1 request per second per RDAP server / WHOIS TLD
RDAP_BODY_CAP = 1_000_000
RETRY_HTTP = {429, 500, 502, 503, 504}
USER_AGENT = "redwhale-takeover-check/1"

VULN_UNREGISTERED = "takeover-unregistered-domain"
VULN_DANGLING = "takeover-dangling-cname"

# WHOIS: the only labels read (case-insensitive, "label: value" at the start of a line). Anything else is ignored;
# no expiry label with a date we understand -> unknown. Never a guess, never "not registered".
WHOIS_EXPIRY_LABELS = ["registry expiry date", "registrar registration expiration date", "expiry date",
                       "expiration date", "expiration time", "expires on", "expire date", "paid-till", "expires"]
WHOIS_CREATED_LABELS = ["creation date", "created on", "created", "registered on", "registration time"]
WHOIS_REGISTRAR_LABELS = ["registrar", "sponsoring registrar"]
WHOIS_DATE_FORMATS = ["%Y-%m-%dT%H:%M:%SZ", "%Y-%m-%dT%H:%M:%S.%fZ", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%S.%f%z",
                      "%Y-%m-%d %H:%M:%S", "%Y-%m-%d", "%Y.%m.%d", "%d-%b-%Y", "%Y/%m/%d"]


class Missing(Exception):
    """A replay asked for an exchange the transcript doesn't have."""


# ---------------------------------------------------------------------------------------------------------- nets

class LiveNet:
    """Real DNS (dnsx), RDAP (urllib, no redirects) and WHOIS (the whois command). Every exchange is recorded."""

    def __init__(self, target, target_type, timeout, bootstrap=None, runner=subprocess.run, opener=None,
                 sleep=time.sleep, clock=time.monotonic, stamp=now):
        self.transcript = new_transcript(target, target_type)
        self.bootstrap = bootstrap if bootstrap is not None else load_bootstrap(BOOTSTRAP_FILE)
        self.runner, self.sleep, self.clock, self.stamp = runner, sleep, clock, stamp
        self.opener = opener or urllib.request.build_opener(NoRedirect()).open
        self.deadline = clock() + timeout
        self.last = {}  # server key -> clock() of its last request

    def _record(self, ex):
        self.transcript["exchanges"].append(ex)
        return ex

    def _polite(self, server):
        wait = self.last.get(server, -1e9) + PER_SERVER_SECONDS - self.clock()
        if wait > 0:
            self.sleep(wait)
        self.last[server] = self.clock()

    def _run(self, argv, seconds):
        out = {"argv": argv, "at": self.stamp(), "exit": None, "stdout": "", "stderr": "", "error": None}
        left = self.deadline - self.clock()
        if left < 2:
            out["error"] = "out of time"
            return out
        try:
            p = self.runner(argv, capture_output=True, text=True, encoding="utf-8", errors="replace",
                            timeout=min(seconds, left), stdin=subprocess.DEVNULL)
            out.update(exit=p.returncode, stdout=p.stdout, stderr=p.stderr[-2000:])
        except FileNotFoundError:
            out["error"] = f"'{argv[0]}' not found"
        except subprocess.TimeoutExpired:
            out["error"] = f"timed out after {min(seconds, left):.0f} s"
        except OSError as e:
            out["error"] = str(e)
        return out

    def dns(self, name, query):
        argv = dnsx_argv(name, query, resolver_args())
        return self._record({"kind": "dns", "query": query, "name": name, **self._run(argv, DNSX_SECONDS)})

    def rdap_servers(self, domain):
        entry, servers = bootstrap_lookup(self.bootstrap, domain)
        self.transcript["bootstrap"][domain] = {"entry": entry, "servers": servers}
        return servers

    def rdap(self, domain, base):
        url = rdap_url(base, domain)
        server = urllib.parse.urlsplit(url).hostname or url
        ex = {"kind": "rdap", "domain": domain, "url": url, "attempts": [], "status": None, "body": None}
        for attempt in range(TRIES):
            if attempt:
                self.sleep(BACKOFF_SECONDS[attempt - 1])
            left = self.deadline - self.clock()
            if left < 2:
                ex["attempts"].append({"at": self.stamp(), "status": None, "error": "out of time"})
                break
            self._polite(server)
            a = {"at": self.stamp(), "status": None, "error": None}
            ex["attempts"].append(a)
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT,
                                                           "Accept": "application/rdap+json, application/json"})
                with self.opener(req, timeout=min(RDAP_SECONDS, left)) as resp:
                    a["status"] = resp.status
                    ex["body"] = resp.read(RDAP_BODY_CAP).decode("utf-8", "replace")
            except urllib.error.HTTPError as e:
                a["status"] = e.code
                if 300 <= e.code < 400:
                    a["location"] = e.headers.get("Location")
            except (urllib.error.URLError, TimeoutError, OSError) as e:
                a["error"] = f"{type(e).__name__}: {getattr(e, 'reason', e)}"
            ex["status"] = a["status"]
            if a["status"] is not None and a["status"] not in RETRY_HTTP:
                break
        return self._record(ex)

    def whois(self, domain):
        self._polite("whois:" + domain.rsplit(".", 1)[-1])  # whois picks the server per TLD itself
        return self._record({"kind": "whois", "domain": domain, **self._run([WHOIS, domain], WHOIS_SECONDS)})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """A 3xx comes back as an HTTPError: RDAP redirects are never followed (only declared servers are contacted)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


class ReplayNet:
    """Answers from a transcript; asking for something it doesn't hold raises Missing."""

    def __init__(self, transcript):
        self.transcript = transcript
        self.answers = {}
        for ex in transcript.get("exchanges") or []:
            if isinstance(ex, dict):
                self.answers.setdefault(exchange_key(ex), ex)

    def _get(self, key):
        ex = self.answers.get(key)
        if ex is None:
            raise Missing(" ".join(str(k) for k in key))
        return ex

    def dns(self, name, query):
        return self._get(("dns", query, name))

    def rdap_servers(self, domain):
        b = (self.transcript.get("bootstrap") or {}).get(domain)
        if not isinstance(b, dict):
            raise Missing(f"bootstrap {domain}")
        return list(b.get("servers") or [])

    def rdap(self, domain, base):
        return self._get(("rdap", domain))

    def whois(self, domain):
        return self._get(("whois", domain))


def exchange_key(ex):
    if ex.get("kind") == "dns":
        return ("dns", ex.get("query"), ex.get("name"))
    return (ex.get("kind"), ex.get("domain"))


def new_transcript(target, target_type):
    return {"transcript": TRANSCRIPT_VERSION, "tool": TOOL, "target": target, "target_type": target_type,
            "data": data_versions(), "bootstrap": {}, "exchanges": []}


def data_versions():
    out = {}
    for key, path in (("psl", PSL_FILE), ("rdap_bootstrap", BOOTSTRAP_FILE)):
        try:
            raw = path.read_bytes()
        except OSError:
            continue
        out[f"{key}_sha256"] = hashlib.sha256(raw).hexdigest()
        if key == "psl":
            m = re.search(rb"^// VERSION: (.+)$", raw, re.M)
            out["psl_version"] = m.group(1).decode().strip() if m else None
        else:
            try:
                out["rdap_bootstrap_publication"] = json.loads(raw).get("publication")
            except ValueError:
                pass
    return out


# ------------------------------------------------------------------------------------------------ DNS / RDAP

def dnsx_argv(name, query, resolvers):
    # Flags checked against `dnsx -h` of v1.3.1 (docs/phase-tw1-progress.md). In v1.3.1 an rcode is only printed by
    # the plain -rcode mode (an A query); with -cname, a name with no CNAME or NXDOMAIN prints nothing. So each hop
    # is asked "-cname" first (its line carries status_code), and "-rcode" only when that printed nothing.
    #   -l name                       exactly this one name (no -d/-w: never brute-force)
    #   -j -silent -nc -duc -or       JSON lines only, no colors, no update check, no raw packet in the JSON
    #   -retry 2 -timeout 5s -t 1 -rl 10   conservative: one name, one thread
    #   -r <own resolvers>            the machine's resolver only; main(needs_resolvers=True) refuses without one
    kind = ["-cname"] if query == "cname" else ["-rcode", RCODES]
    return [DNSX, "-l", name, *kind, "-j", "-silent", "-nc", "-duc", "-or",
            "-retry", "2", "-timeout", "5s", "-t", "1", "-rl", "10", *resolvers]


def dnsx_answer(ex, name):
    """(cname or None, status or None, problem or None) from one dns exchange."""
    if ex.get("error"):
        return None, None, f"dnsx for {name}: {ex['error']}"
    if ex.get("exit") not in (0, None):
        return None, None, f"dnsx for {name} exited with {ex.get('exit')}: {str(ex.get('stderr', '')).strip()[-200:]}"
    for line in str(ex.get("stdout") or "").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            item = json.loads(line)
        except ValueError:
            return None, None, f"dnsx for {name} printed a line that is not JSON: {line[:100]}"
        if not isinstance(item, dict) or clean_host(item.get("host") or "") != name:
            continue
        cnames = [clean_host(c) for c in item.get("cname") or [] if isinstance(c, str) and clean_host(c)]
        status = item.get("status_code") if isinstance(item.get("status_code"), str) else None
        return (cnames[0] if cnames else None), status, None
    return None, None, None


def load_bootstrap(path):
    with open(path, encoding="utf-8") as fh:
        doc = json.load(fh)
    table = {}
    for service in doc.get("services") or []:
        if isinstance(service, list) and len(service) == 2:
            for entry in service[0]:
                table[str(entry).lower()] = [str(u) for u in service[1]]
    return table


def bootstrap_lookup(table, domain):
    """(matching entry, its https base URLs): the longest bootstrap entry the domain ends with (RFC 9224 §4)."""
    labels = domain.split(".")
    for i in range(1, len(labels)):
        entry = ".".join(labels[i:])
        if entry in table:
            return entry, [u for u in table[entry] if u.lower().startswith("https://")]
    return None, []


def rdap_url(base, domain):
    return base.rstrip("/") + "/domain/" + urllib.parse.quote(domain)


def iso(value):
    """An RDAP/WHOIS date as YYYY-MM-DDTHH:MM:SSZ (UTC), or None if it isn't one we understand."""
    if not isinstance(value, str) or not value.strip():
        return None
    v = value.strip()
    for fmt in WHOIS_DATE_FORMATS:
        try:
            dt = datetime.strptime(v, fmt)
            break
        except ValueError:
            continue
    else:
        try:
            dt = datetime.fromisoformat(v.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def unknown(source, at, reason):
    return {"registered": None, "expires_at": None, "registrar": None, "created_at": None, "source": source,
            "checked_at": at, "reason": reason}


def rdap_registration(ex, domain):
    """registered / expires_at / registrar / created_at / source / checked_at (+ reason when unknown)."""
    attempts = ex.get("attempts") or []
    last = attempts[-1] if attempts else {}
    at = last.get("at")
    host = urllib.parse.urlsplit(str(ex.get("url") or "")).hostname
    status = ex.get("status")
    if status == 404:
        return {"registered": False, "expires_at": None, "registrar": None, "created_at": None, "source": "rdap",
                "checked_at": at, "reason": f"RDAP 404 from {host}"}
    if isinstance(status, int) and 300 <= status < 400:
        where = urllib.parse.urlsplit(str(last.get("location") or "")).hostname or "an unknown host"
        return unknown("rdap", at, f"RDAP {status} redirect to {where} (not followed)")
    if status != 200:
        problem = f"RDAP {status}" if status is not None else (last.get("error") or "no answer")
        return unknown("rdap", at, f"{problem} from {host} after {len(attempts)} tr{'y' if len(attempts) == 1 else 'ies'}")
    try:
        doc = json.loads(ex.get("body") or "")
    except ValueError:
        return unknown("rdap", at, f"RDAP 200 from {host} was not JSON")
    if not isinstance(doc, dict):
        return unknown("rdap", at, f"RDAP 200 from {host} was not a JSON object")
    ldh = doc.get("ldhName")
    if isinstance(ldh, str) and clean_host(ldh) != domain:
        return unknown("rdap", at, f"RDAP 200 from {host} answered for another name ({ldh[:100]})")
    events = {}
    for e in doc.get("events") or []:
        if isinstance(e, dict) and isinstance(e.get("eventAction"), str):
            events.setdefault(e["eventAction"].lower(), e.get("eventDate"))
    return {"registered": True, "expires_at": iso(events.get("expiration")), "registrar": rdap_registrar(doc),
            "created_at": iso(events.get("registration")), "source": "rdap", "checked_at": at}


def rdap_registrar(doc):
    for ent in doc.get("entities") or []:
        if not isinstance(ent, dict) or "registrar" not in (ent.get("roles") or []):
            continue
        vcard = ent.get("vcardArray")
        if isinstance(vcard, list) and len(vcard) == 2 and isinstance(vcard[1], list):
            for prop in vcard[1]:
                if isinstance(prop, list) and len(prop) >= 4 and prop[0] == "fn" and isinstance(prop[3], str):
                    return prop[3].strip() or None
    return None


def whois_registration(ex, domain):
    at = ex.get("at")
    if ex.get("error"):
        return unknown("whois", at, f"whois: {ex['error']}")
    if ex.get("exit") not in (0, None):
        return unknown("whois", at, f"whois exited with {ex.get('exit')}")
    fields = {}
    for line in str(ex.get("stdout") or "").splitlines():
        label, sep, value = line.strip().partition(":")
        if sep and value.strip():
            fields.setdefault(label.strip().lower(), value.strip())
    expiry_raw = next((fields[k] for k in WHOIS_EXPIRY_LABELS if k in fields), None)
    if expiry_raw is None:
        return unknown("whois", at, "no expiry date in the WHOIS answer")
    expires = iso(expiry_raw)
    if expires is None:
        return unknown("whois", at, f"WHOIS expiry date not understood: {expiry_raw[:60]!r}")
    created = next((iso(fields[k]) for k in WHOIS_CREATED_LABELS if k in fields), None)
    registrar = next((fields[k][:200] for k in WHOIS_REGISTRAR_LABELS if k in fields), None)
    return {"registered": True, "expires_at": expires, "registrar": registrar, "created_at": created,
            "source": "whois", "checked_at": at}


# ---------------------------------------------------------------------------------------------------- the logic

def is_host(name):
    return contract.check_value("subdomain", name) is None


def investigate(target, net, psl):
    """
    The whole check against `net` (live or replay). Returns a dict:
      chain     [target, hop1, ...] in order
      rcode     name -> rcode (None when DNS gave no answer)
      loops_to  name -> the earlier name its CNAME points back at
      lookups   domain -> registration dict, in lookup order
      problems  error messages (each becomes run.error)
    """
    out = {"chain": [target], "rcode": {}, "loops_to": {}, "lookups": {}, "problems": []}
    problems = out["problems"]
    current = target
    while True:
        try:
            cname, status, problem = dnsx_answer(net.dns(current, "cname"), current)
            if cname is None and not problem:
                _, status, problem = dnsx_answer(net.dns(current, "rcode"), current)
                problem = problem or (None if status else f"no DNS answer for {current}")
        except Missing as e:
            cname, status, problem = None, None, f"the transcript has no answer for {e}; the chain stops there"
        if problem:
            problems.append(problem)
        out["rcode"][current] = status
        if cname is None:
            break
        if cname in out["chain"]:
            out["loops_to"][current] = cname
            problems.append(f"CNAME loop: {current} points back at {cname}; stopped")
            break
        if len(out["chain"]) - 1 >= MAX_HOPS:
            problems.append(f"CNAME chain longer than {MAX_HOPS} hops; stopped at {current} -> {cname}")
            break
        if not is_host(cname) or "," in cname or os.path.exists(cname):
            problems.append(f"CNAME target {cname[:100]!r} of {current} is not a usable hostname; stopped")
            break
        if psl.registrable(cname) is None:
            problems.append(f"CNAME target {cname} of {current} is a public suffix, not a name; stopped")
            break
        out["chain"].append(cname)
        current = cname

    own = psl.registrable(target)
    domains = [own] if own else []
    for name in out["chain"][1:]:
        reg = psl.registrable(name)
        if reg and reg not in domains and not psl.private_suffix(name):
            domains.append(reg)
    for d in domains:
        try:
            servers = net.rdap_servers(d)
            if servers:
                out["lookups"][d] = rdap_registration(net.rdap(d, servers[0]), d)
            else:
                out["lookups"][d] = whois_registration(net.whois(d), d)
        except Missing as e:
            out["lookups"][d] = unknown(None, None, f"the transcript has no answer for {e}")
        if out["lookups"][d]["registered"] is None:
            problems.append(f"registration of {d} unknown: {out['lookups'][d]['reason']}")
    return out


def node_type(name, psl):
    return "domain" if psl.registrable(name) == name else "subdomain"


def report(run, target, found, psl):
    """Findings from investigate()'s result."""
    chain, lookups = found["chain"], found["lookups"]
    own = psl.registrable(target)
    hop_data = {}
    for name in chain[1:]:
        d = {"rcode": found["rcode"].get(name)}
        svc = psl.private_suffix(name)
        if svc:
            d["service"] = svc
        if name in found["loops_to"]:
            d["loops_to"] = found["loops_to"][name]
        if name in lookups:  # a hop that is itself a registrable domain carries its registration
            d.update(lookups[name])
        hop_data[name] = d

    prev_type = run.target_type
    for prev, name in zip(chain, chain[1:]):
        ntype = node_type(name, psl)
        if prev_type == "subdomain":
            run.add(ntype, name, parent=(prev_type, prev), relation="cname_to", data=hop_data[name])
        else:  # a CNAME at a registrable domain (apex): cname_to only leaves subdomains, so it's data
            run.add(ntype, name, data=hop_data[name])
            log(f"note: {prev} (a domain) has a CNAME to {name}; recorded as data, not as an edge")
        if ntype == "subdomain":
            run.add("subdomain", name, parent=("domain", psl.registrable(name)), relation="has_subdomain")
        prev_type = ntype

    for d, reg in lookups.items():
        if d not in hop_data:
            run.add("domain", d, data=reg)  # no parent: the chain names hang under it (has_subdomain)

    victim = (run.target_type, target)
    for d, reg in lookups.items():
        if reg["registered"] is not False:
            continue
        names = [n for n in chain if psl.registrable(n) == d]
        run.add("vulnerability", VULN_UNREGISTERED, parent=victim, relation="has_vulnerability", severity="critical",
                data={"chain": chain, "name": names[0] if names else d, "domain": d,
                      "reason": f"{d} is not registered ({reg['reason']}): whoever registers it controls "
                                f"{names[0] if names else d}, which {target} points to"})
    for name in chain[1:]:
        reg_domain = psl.registrable(name)
        if found["rcode"].get(name) != "NXDOMAIN" or reg_domain == own:
            continue  # a missing name in the target's own domain is the zone owner's to fix, not a takeover
        svc = psl.private_suffix(name)
        reg = lookups.get(reg_domain) or {}
        if reg.get("registered") is False:
            continue  # already the critical finding
        if not svc and reg.get("registered") is not True:
            continue
        why = (f"{name} does not exist (NXDOMAIN) under {svc}, a cloud service: whoever claims that name there "
               f"may answer for {target}" if svc else
               f"{name} does not exist (NXDOMAIN) but {reg_domain} is registered: if its owner lets anyone create "
               f"that name, they may answer for {target}")
        data = {"chain": chain, "name": name, "reason": why}
        data.update({"service": svc} if svc else {"domain": reg_domain})
        run.add("vulnerability", VULN_DANGLING, parent=victim, relation="has_vulnerability", severity="medium",
                data=data)


# ------------------------------------------------------------------------------------------------- the script

_psl = None


def psl_list():
    global _psl
    if _psl is None:
        _psl = PublicSuffixList.load(PSL_FILE)
    return _psl


def check_target(target, target_type):
    if target_type != "subdomain":
        raise ValueError(f"refusing target {target!r}: takeover-check takes a subdomain, not a {target_type}")
    if not is_host(target) or "," in target or os.path.exists(target):
        raise ValueError(f"refusing target {target!r}: not a hostname dnsx would read as one name")


def command_text(transcript):
    dns = [ex for ex in transcript.get("exchanges") or [] if isinstance(ex, dict) and ex.get("kind") == "dns"]
    rest = len(transcript.get("exchanges") or []) - 1
    if not dns or not isinstance(dns[0].get("argv"), list):
        return f"{TOOL} {transcript.get('target')}"
    return shlex.join(dns[0]["argv"]) + (f"  (+ {rest} more DNS/RDAP/WHOIS exchanges, in raw.txt)" if rest > 0 else "")


def fetch(target, run, timeout, net=None):
    """Runs the live check and returns the transcript (JSON text); parse() builds the findings from it."""
    try:
        check_target(target, run.target_type)
    except ValueError as e:
        run.error(str(e))
        run.command = f"{TOOL} {target} (refused)"
        return ""
    net = net or LiveNet(target, run.target_type, timeout)
    try:
        investigate(target, net, psl_list())  # the findings come from replaying the transcript, in parse()
    except Exception as e:  # keep what was recorded: the replay will hit the same problem and say so
        log(f"live check stopped: {type(e).__name__}: {e}")
    run.command = command_text(net.transcript)
    return json.dumps(net.transcript, indent=1, ensure_ascii=False) + "\n"


def parse(raw, run, target):
    if not raw.strip():
        return
    transcript = json.loads(raw)
    if not isinstance(transcript, dict) or transcript.get("transcript") != TRANSCRIPT_VERSION:
        run.error(f"not a takeover-check transcript (version {TRANSCRIPT_VERSION})")
        return
    if transcript.get("target") != target or transcript.get("target_type") != run.target_type:
        run.error(f"transcript is for {transcript.get('target_type')} {transcript.get('target')}, "
                  f"not {run.target_type} {target}")
        return
    try:
        check_target(target, run.target_type)
    except ValueError as e:
        run.error(str(e))
        return
    if run.command.endswith("(replayed)"):
        run.command = command_text(transcript) + "  (replayed)"
    psl = psl_list()
    found = investigate(target, ReplayNet(transcript), psl)
    for p in found["problems"]:
        run.error(p)
    report(run, target, found, psl)


if __name__ == "__main__":
    sys.exit(main(TOOL, parse, fetch=fetch, needs_target_type=True, needs_resolvers=True))
