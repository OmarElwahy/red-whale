# RED WHALE tool group: DNS (dnsx, takeover-check). Passive: asks only the system DNS resolver and, for
# takeover-check, RDAP and WHOIS servers about registrations; never the target.
# Build with `pnpm tools:build dns`: the context is tools/ (see tools/.dockerignore), and the image is tagged with a
# hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# Every tool is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
# linux/amd64 only (the release binaries are amd64).
#   dnsx  v1.3.1 (released 2026-08-31)  sha256 from the release's dnsx_1.3.1_checksums.txt (pinned 2026-11-11)
#
# The one exception, as for nmap in tools/ports: whois comes from the base image's Debian (trixie) repository, pinned
# to an exact package version (WHOIS_VERSION below); apt checks Debian's signatures. When Debian replaces that version,
# the install fails: bump WHOIS_VERSION to what `apt-cache policy whois` shows in this base image
# (docs/architecture.md §13).
#
# dns/data/ (Public Suffix List, IANA RDAP bootstrap) is bundled from the build context, written only by
# `pnpm tools:refresh-data`: refreshing it changes this image's tag. Nothing is fetched at build or run time.
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py \
      https://github.com/projectdiscovery/dnsx/releases/download/v1.3.1/dnsx_1.3.1_linux_amd64.zip \
      438b964653056dd51dcfe614b1a16f8bced3cc48a1d27bc07cc6fdf2ef2a9533 dnsx /dist/dnsx

FROM ${PYTHON_IMAGE}
# The runner starts containers as 10001:10001 with a read-only root filesystem; /out is the per-job volume
# (owned by this user, so the new volume is too) and /tmp a tmpfs.
RUN groupadd --gid 10001 redwhale \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin redwhale \
 && mkdir -p /out \
 && chown 10001:10001 /out
COPY --from=fetch /dist/ /usr/local/bin/
#   whois 5.6.3 (Debian trixie, pinned 2026-11-24), takeover-check's fallback for TLDs without RDAP.
ARG WHOIS_VERSION=5.6.3
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && { apt-get install -y --no-install-recommends "whois=${WHOIS_VERSION}" \
      || { echo "✗ apt could not install whois=${WHOIS_VERSION}: the pinned whois version may have left Debian's repository; bump WHOIS_VERSION in tools/dns/Dockerfile" >&2; exit 1; }; } \
 && rm -rf /var/lib/apt/lists/*
COPY validate_output.py /opt/redwhale/validate_output.py
COPY lib/redwhale_tool.py /opt/redwhale/lib/redwhale_tool.py
COPY lib/psl.py /opt/redwhale/lib/psl.py
COPY dns/ /opt/redwhale/dns/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /tmp
USER 10001:10001
