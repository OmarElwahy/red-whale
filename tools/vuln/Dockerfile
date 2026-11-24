# RED WHALE tool group: vulnerability scanning (nuclei). ACTIVE: nuclei sends HTTP requests to the target itself.
# Build with `pnpm tools:build vuln`: the context is tools/ (see tools/.dockerignore), and the image is tagged with a
# hash of everything that goes into it, so the server can tell a stale image from a current one.
#
# Everything is pinned to an exact release and its archive's sha256; fetch_release.py refuses anything else.
# linux/amd64 only (the release binary is amd64).
#   nuclei            v3.11.1 (released 2026-08-08)  sha256 from the release's nuclei_3.11.1_checksums.txt (pinned 2026-11-24)
#   nuclei-templates  v10.5.1 (released 2026-10-23)  sha256 from the release's nuclei-templates-10.5.1_checksums.txt
#                     (GitHub's source archive of the tag; pinned 2026-11-24). Baked in, read-only: nuclei never
#                     downloads or updates templates (run.py passes -duc and the templates folder explicitly).
ARG PYTHON_IMAGE=python:3.13-slim-trixie@sha256:ae14d4ce8771606477a81446e7ef429edd6762305fc50c84507c1041fa8285d1

FROM ${PYTHON_IMAGE} AS fetch
COPY lib/fetch_release.py /fetch_release.py
RUN python /fetch_release.py \
      https://github.com/projectdiscovery/nuclei/releases/download/v3.11.1/nuclei_3.11.1_linux_amd64.zip \
      ea63d4ae232808cd7c6bc00d0142428e231fab59dae01042246097d195835ab6 nuclei /dist/bin/nuclei \
 && python /fetch_release.py --tree \
      https://github.com/projectdiscovery/nuclei-templates/archive/refs/tags/v10.5.1.tar.gz \
      30fe1cfaced4635f886e4a2673641bba86998dceec28e468274524e789aa56eb nuclei-templates-10.5.1 /dist/nuclei-templates

FROM ${PYTHON_IMAGE}
# The runner starts containers as 10001:10001 with a read-only root filesystem; /out is the per-job volume
# (owned by this user, so the new volume is too) and /tmp a tmpfs. The templates stay root-owned (read-only to nuclei).
RUN groupadd --gid 10001 redwhale \
 && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp --shell /usr/sbin/nologin redwhale \
 && mkdir -p /out \
 && chown 10001:10001 /out
COPY --from=fetch /dist/bin/ /usr/local/bin/
COPY --from=fetch /dist/nuclei-templates/ /opt/nuclei-templates/
# nuclei's config folder, made here and read-only at run time (root-owned). nuclei needs config.yaml and
# reporting-config.yaml to exist (empty is fine; it fails trying to create them on a read-only folder) and reads the
# templates' default ignore list (.nuclei-ignore: dos, local, fuzz, bruteforce, txt-service tags and a few templates
# with weak matchers) only from here. Nothing in it is ever downloaded; nuclei itself never runs at build time.
RUN mkdir -p /opt/nuclei-config \
 && cp /opt/nuclei-templates/.nuclei-ignore /opt/nuclei-config/.nuclei-ignore \
 && : > /opt/nuclei-config/config.yaml \
 && : > /opt/nuclei-config/reporting-config.yaml \
 && printf '{"nuclei-templates-directory":"/opt/nuclei-templates"}' > /opt/nuclei-config/.templates-config.json \
 && chmod 0755 /opt/nuclei-config \
 && chmod 0644 /opt/nuclei-config/.nuclei-ignore /opt/nuclei-config/*.yaml /opt/nuclei-config/.templates-config.json
COPY validate_output.py /opt/redwhale/validate_output.py
COPY lib/redwhale_tool.py /opt/redwhale/lib/redwhale_tool.py
COPY vuln/ /opt/redwhale/vuln/
# The DISABLE_* switches are a second lock on template downloads (run.py's -duc is the first).
ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 \
    NUCLEI_CONFIG_DIR=/opt/nuclei-config NUCLEI_TEMPLATES_DIR=/opt/nuclei-templates \
    DISABLE_NUCLEI_TEMPLATES_PUBLIC_DOWNLOAD=true DISABLE_NUCLEI_TEMPLATES_GITHUB_DOWNLOAD=true \
    DISABLE_NUCLEI_TEMPLATES_GITLAB_DOWNLOAD=true DISABLE_NUCLEI_TEMPLATES_AWS_DOWNLOAD=true \
    DISABLE_NUCLEI_TEMPLATES_AZURE_DOWNLOAD=true
WORKDIR /tmp
USER 10001:10001
