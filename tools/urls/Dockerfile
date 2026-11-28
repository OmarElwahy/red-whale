# RED WHALE tool group: URL discovery (gau, katana). gau is PASSIVE (asks archives about the target); katana is ACTIVE
# (crawls the target itself).
# Build with `pnpm tools:build urls`: the context is tools/ (see tools/.dockerignore), and the image is tagged with a
# hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# Every tool is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
# linux/amd64 only (the release binaries are amd64).
#   gau     v2.2.4 (released 2024-10-28)  sha256 from the release's gau_2.2.4_checksums.txt (pinned 2026-11-23)
#   katana  v1.8.0 (released 2026-10-05)  sha256 from the release's katana-1.8.0-checksums.txt (pinned 2026-11-23)
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py \
      https://github.com/lc/gau/releases/download/v2.2.4/gau_2.2.4_linux_amd64.tar.gz \
      10e2e248c37cafb0be3f6d2931125296b95cd4186066d596d47fa417237529a9 gau /dist/gau \
 && python /fetch_release.py \
      https://github.com/projectdiscovery/katana/releases/download/v1.8.0/katana_1.8.0_linux_amd64.zip \
      cb027ae99d0757061b70c07a15c7a80f62c5a535ab52c4a329f80c4b0a7309d2 katana /dist/katana

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
COPY urls/ /opt/redwhale/urls/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /tmp
USER 10001:10001
