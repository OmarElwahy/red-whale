# RED WHALE tool group: TLS checks (testssl.sh). ACTIVE: testssl.sh makes TLS handshakes with the target itself.
# Build with `pnpm tools:build tls`: the context is tools/ (see tools/.dockerignore), and the image is tagged with a
# hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# testssl.sh is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
#   testssl.sh  v3.2.5 (released 2026-11-04)  GitHub's source archive of the tag (the release has no other asset and
#               publishes no checksum): sha256 computed from the download on 2026-11-24. If GitHub ever serves other
#               bytes, the build fails on the checksum (never different content). The archive brings testssl's own
#               OpenSSL build (bin/openssl.Linux.x86_64, with the old protocols and ciphers testssl needs to test
#               for); the image's /usr/bin/openssl (from the pinned Python base) is testssl's second one (TLS 1.3).
# linux/amd64 only (the bundled openssl is x86_64).
# Debian packages testssl needs that the base lacks, exact versions (trixie): ps (procps), hexdump (bsdextrautils),
# dig (bind9-dnsutils: name resolution through the system resolver only), gawk. No curl, wget or socat: testssl's
# --phone-out (CRL/OCSP downloads) is never passed, and without a download tool it couldn't fetch anything anyway.
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py --tree \
      https://github.com/testssl/testssl.sh/archive/refs/tags/v3.2.5.tar.gz \
      23bb53d50ae093b89631e9fff547c087f632bf35f7a3d7dc78dd4ffff56cd779 testssl.sh-3.2.5 /dist/testssl \
 && rm -f /dist/testssl/bin/openssl.Darwin.x86_64 /dist/testssl/bin/openssl.FreeBSD.amd64 \
 && chmod 0755 /dist/testssl/testssl.sh /dist/testssl/bin/openssl.Linux.x86_64

FROM ${PYTHON_IMAGE}
# The runner starts containers as 10001:10001 with a read-only root filesystem; /out is the per-job volume
# (owned by this user, so the new volume is too) and /tmp a tmpfs. testssl stays root-owned (read-only to the tool).
RUN groupadd --gid 10001 redwhale \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin redwhale \
 && mkdir -p /out \
 && chown 10001:10001 /out
ARG PROCPS_VERSION=2:4.0.4-9
ARG BSDEXTRAUTILS_VERSION=2.41.5-0+deb13u1
ARG BIND9_VERSION=1:9.20.30-1~deb13u1
ARG GAWK_VERSION=1:5.2.1-2+b1
RUN export DEBIAN_FRONTEND=noninteractive \
 && apt-get update \
 && { apt-get install -y --no-install-recommends "procps=${PROCPS_VERSION}" \
        "bsdextrautils=${BSDEXTRAUTILS_VERSION}" "bind9-dnsutils=${BIND9_VERSION}" "gawk=${GAWK_VERSION}" \
      || { echo "✗ apt could not install testssl's pinned Debian packages: a pinned version may have left Debian's repository; bump it in tools/tls/Dockerfile" >&2; exit 1; }; } \
 && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /dist/testssl/ /opt/testssl/
COPY validate_output.py /opt/redwhale/validate_output.py
COPY lib/redwhale_tool.py /opt/redwhale/lib/redwhale_tool.py
COPY tls/ /opt/redwhale/tls/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 TESTSSL_INSTALL_DIR=/opt/testssl
WORKDIR /tmp
USER 10001:10001
