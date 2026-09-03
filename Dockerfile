FROM alpine:3.23 AS cliproxy

ARG TARGETARCH
ARG CLIPROXY_VERSION=7.2.75
RUN apk add --no-cache ca-certificates curl tar \
    && case "${TARGETARCH}" in \
         arm64) archive_arch="aarch64"; checksum="48ef8381ca26d380e04bad5d0387469b4e13d5bb3beee11dc7276c7a1e23efa9" ;; \
         amd64) archive_arch="amd64"; checksum="d4aeec774e42f832b17d60c81a909655cfd3a435cfafc91aa5f983ff8d2b3692" ;; \
         *) echo "Unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
       esac \
    && archive="CLIProxyAPI_${CLIPROXY_VERSION}_linux_${archive_arch}.tar.gz" \
    && curl -fsSLo "/tmp/${archive}" "https://github.com/router-for-me/CLIProxyAPI/releases/download/v${CLIPROXY_VERSION}/${archive}" \
    && echo "${checksum}  /tmp/${archive}" | sha256sum -c - \
    && tar -xzf "/tmp/${archive}" -C /tmp \
    && install -m 0755 /tmp/cli-proxy-api /usr/local/bin/cli-proxy-api

FROM node:22-slim

RUN apt-get update && apt-get install -y procps curl wget && rm -rf /var/lib/apt/lists/*

RUN npm install -g @tokligence/gateway@0.4.0

COPY --from=cliproxy /usr/local/bin/cli-proxy-api /usr/local/bin/cli-proxy-api

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tgw-proxy.mjs openai-stream.mjs sanitize-headers.mjs routing-planner.mjs request-executor.mjs provider-adapters.mjs protocol-codecs.mjs cline-oauth.mjs usage-observer.mjs ./
COPY gateway-config.mjs ./
COPY route-config.mjs compile-config.mjs gateway.routes.yaml ./
COPY quota.mjs preferences.mjs dashboard.mjs dashboard.html cloudflare-access.mjs model-catalog.mjs copilot-auto.mjs ./
# Copilot SDK state must live on the mounted data volume; credentials are supplied
# through COPILOT_GITHUB_TOKEN (or an interactive device login), never baked in.
ENV COPILOT_AUTO_HOME=/data/copilot-auto
# Routing-preference overrides persist to the mounted /data volume.
ENV ROUTING_PREFERENCES_PATH=/data/gateway.preferences.yaml
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

EXPOSE 8080

CMD ["./entrypoint.sh"]
