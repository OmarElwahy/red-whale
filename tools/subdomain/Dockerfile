# RED WHALE tool group: subdomain enumeration (subfinder, assetfinder, findomain, crt.sh).
# Build with `pnpm tools:build subdomain`: the context is tools/ (see tools/.dockerignore), and the image is tagged
# with a hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# Every tool is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
# linux/amd64 only (the release binaries are amd64).
#   subfinder   v2.17.0  sha256 from the release's checksums.txt
#   assetfinder v0.1.1   no published checksum: sha256 computed when pinned (2026-11-02)
#   findomain   10.0.1   sha256 as listed by GitHub for the release asset
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py \
      https://github.com/projectdiscovery/subfinder/releases/download/v2.17.0/subfinder_2.17.0_linux_amd64.zip \
      a39c3e5c7a26ef3c430915c4d6cbf7716a00f26769a75e9405aba796142eba37 subfinder /dist/subfinder \
 && python /fetch_release.py \
      https://github.com/tomnomnom/assetfinder/releases/download/v0.1.1/assetfinder-linux-amd64-0.1.1.tgz \
      a7c61fe7b8ac16b35b94c1967dfabe0a536efd04283a3764226b30ff75472b20 assetfinder /dist/assetfinder \
 && python /fetch_release.py \
      https://github.com/Findomain/Findomain/releases/download/10.0.1/findomain-linux.zip \
      7a1b90aaf291868e0fb2d643cefa238caddb7aa932b2355f0e0ce8b47a4b5083 findomain /dist/findomain

FROM ${PYTHON_IMAGE}
# The runner starts containers as 10001:10001 with a read-only root filesystem; /out is the per-job volume
# (owned by this user, so the new volume is too) and /tmp a tmpfs.
RUN groupadd --gid 10001 redwhale \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin redwhale \
 && mkdir -p /out \
 && chown 10001:10001 /out
COPY --from=fetch /dist/ /usr/local/bin/
COPY validate_output.py /opt/redwhale/validate_output.py
COPY lib/redwhale_tool.py /opt/redwhale/lib/redwhale_tool.py
COPY subdomain/ /opt/redwhale/subdomain/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /tmp
USER 10001:10001
