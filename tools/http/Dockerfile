# RED WHALE tool group: HTTP probing (httpx, wafw00f). ACTIVE: these tools talk to the target itself.
# Build with `pnpm tools:build http`: the context is tools/ (see tools/.dockerignore), and the image is tagged with a
# hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# Every tool is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
# linux/amd64 only (the release binaries are amd64).
#   httpx    v1.12.0 (released 2026-09-08)  sha256 from the release's httpx_1.12.0_checksums.txt (pinned 2026-11-03)
#   wafw00f  2.4.2 (released 2026-01-26)    from PyPI with pip --require-hashes: wafw00f/requirements.txt pins it and
#            every dependency (exact versions, each wheel's sha256); wheels only, no dependency resolution, nothing
#            built from source. Installed into its own venv /opt/wafw00f (pinned 2026-11-24).
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py \
      https://github.com/projectdiscovery/httpx/releases/download/v1.12.0/httpx_1.12.0_linux_amd64.zip \
      9d8439e8b6c9aa7d1e2314817a392e00d5178da3af5652f7475f88868f418f76 httpx /dist/httpx
COPY http/wafw00f/requirements.txt /wafw00f-requirements.txt
RUN python -m venv /opt/wafw00f  && /opt/wafw00f/bin/pip install --no-cache-dir --disable-pip-version-check --require-hashes --no-deps       --only-binary :all: -r /wafw00f-requirements.txt  && /opt/wafw00f/bin/pip uninstall --yes --disable-pip-version-check pip

FROM ${PYTHON_IMAGE}
# The runner starts containers as 10001:10001 with a read-only root filesystem; /out is the per-job volume
# (owned by this user, so the new volume is too) and /tmp a tmpfs.
RUN groupadd --gid 10001 redwhale \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin redwhale \
 && mkdir -p /out \
 && chown 10001:10001 /out
COPY --from=fetch /dist/ /usr/local/bin/
# Same base image, same Python path: the venv works as built.
COPY --from=fetch /opt/wafw00f/ /opt/wafw00f/
COPY validate_output.py /opt/redwhale/validate_output.py
COPY lib/redwhale_tool.py /opt/redwhale/lib/redwhale_tool.py
COPY http/ /opt/redwhale/http/
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1
WORKDIR /tmp
USER 10001:10001
