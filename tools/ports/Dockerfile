# RED WHALE tool group: port scanning (naabu, nmap). ACTIVE: these tools connect to the target itself.
# Build with `pnpm tools:build ports`: the context is tools/ (see tools/.dockerignore), and the image is tagged with a
# hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# Every tool is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
# linux/amd64 only (the release binaries are amd64).
#   naabu  v2.7.0 (released 2026-10-28)  sha256 from the release's naabu-checksums.txt (pinned 2026-11-11)
#
# The one exception: nmap comes from the base image's Debian (trixie) repository, pinned to an exact package version
# (NMAP_VERSION below). nmap ships no checksummed Linux binary; apt checks Debian's signatures instead. When Debian
# replaces that version (a point or security release), the install fails: bump NMAP_VERSION to the version
# `apt-cache policy nmap` shows in this base image (docs/architecture.md §13).
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py \
      https://github.com/projectdiscovery/naabu/releases/download/v2.7.0/naabu_2.7.0_linux_amd64.zip \
      0cc77c0ca32d2f519ffbaa7665bb0e7c88c40753ab22f03551d453a1a823e9f0 naabu /dist/naabu

FROM ${PYTHON_IMAGE}
# The runner starts containers as 10001:10001 with a read-only root filesystem; /out is the per-job volume
# (owned by this user, so the new volume is too) and /tmp a tmpfs.
RUN groupadd --gid 10001 redwhale \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin redwhale \
 && mkdir -p /out \
 && chown 10001:10001 /out
COPY --from=fetch /dist/ /usr/local/bin/
#   nmap 7.95+dfsg-3 (Debian trixie, pinned 2026-11-11), with its data files (nmap-common, same version).
ARG NMAP_VERSION=7.95+dfsg-3
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && { apt-get install -y --no-install-recommends "nmap=${NMAP_VERSION}" "nmap-common=${NMAP_VERSION}" \
      || { echo "✗ apt could not install nmap=${NMAP_VERSION}: the pinned nmap version may have left Debian's repository; bump NMAP_VERSION in tools/ports/Dockerfile" >&2; exit 1; }; } \
 && rm -rf /var/lib/apt/lists/*
COPY validate_output.py /opt/redwhale/validate_output.py
COPY lib/redwhale_tool.py /opt/redwhale/lib/redwhale_tool.py
COPY ports/ /opt/redwhale/ports/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /tmp
USER 10001:10001
