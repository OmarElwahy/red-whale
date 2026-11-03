# RED WHALE local lab: a tiny web server that active tools may be pointed at (pnpm lab:up; see lab/README.md).
# It is reached only from job containers, on the redwhale-tools network, as lab.redwhale.test; no host ports.
#
# nginx 1.30.6 (stable) on Alpine, pinned by the multi-arch index digest (2026-11-03).
ARG NGINX_IMAGE=nginx:1.30.6-alpine@sha256:0e52bd054126cdc040b1276c0af347aeb02a41b9cfe305d6094767ac30e97949

# The self-signed certificate is made here, at build time: no key is ever committed. openssl stays in this stage.
FROM ${NGINX_IMAGE} AS cert
RUN apk add --no-cache openssl \
 && mkdir /cert \
 && openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
      -subj "/CN=lab.redwhale.test" \
      -addext "subjectAltName=DNS:lab.redwhale.test,DNS:elsewhere.redwhale.test" \
      -keyout /cert/key.pem -out /cert/cert.pem

FROM ${NGINX_IMAGE}
COPY --from=cert --chown=101:101 /cert/ /etc/nginx/lab/
COPY nginx.conf /etc/nginx/nginx.conf
COPY index.html /usr/share/nginx/lab/index.html
RUN chmod 0400 /etc/nginx/lab/key.pem
# Runs as nginx (101) with a read-only root filesystem; /tmp and /var/cache/nginx are tmpfs (see lab.ts). Ports
# 80/443 are allowed to this user by the container's own net.ipv4.ip_unprivileged_port_start sysctl, not a capability.
USER 101:101
# nginx itself, not the image's docker-entrypoint.sh (its scripts edit conf.d, which this nginx.conf doesn't use).
ENTRYPOINT ["nginx", "-g", "daemon off;"]
CMD []
