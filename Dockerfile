FROM alpine:3.23 AS cliproxy

ARG TARGETARCH
# Stay on the 7.x line. 8.x regrouped config.yaml under server/access/oauth/etc.,
# while compileOAuthProxyYaml (route-config.mjs) still writes the flat 7.x schema,
# so crossing that boundary misconfigures the Codex lane silently.
ARG CLIPROXY_VERSION=7.3.20
RUN apk add --no-cache ca-certificates curl tar \
    && case "${TARGETARCH}" in \
         arm64) archive_arch="aarch64"; checksum="caa1ae89a8364964f317877913efb7f76365fb51f252455ba929b607552f3769" ;; \
         amd64) archive_arch="amd64"; checksum="7050c6ecc68b24493c323d3c51d840a9e4509207f124ea34a8428525e27d9354" ;; \
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

# OpenCode mints the session identity the OpenCode Zen free tier requires: no
# other client produces one the gateway accepts. Pinned to a release that also
# satisfies the user-agent version check the same gate applies.
# The free tier only answers a request that looks like it came from a supported
# OpenCode client. That is the v2 client, which is distributed separately from
# the npm package: opencode-ai stops at the 1.x line, and a v1 client is refused
# with a FreeTierError. The user-agent sent upstream is read from this binary at
# runtime, so the two cannot disagree. Pin with --version when needed; the build
# prints the resolved version so a silent downgrade stays visible.
ARG OPENCODE_VERSION=
RUN set -eux; \
    if [ -n "${OPENCODE_VERSION}" ]; then \
      curl -fsSL https://opencode.ai/v2/install | bash -s -- --version "${OPENCODE_VERSION}" --no-modify-path; \
    else \
      curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path; \
    fi; \
    install -m 0755 /root/.opencode/bin/opencode /usr/local/bin/opencode; \
    opencode --version

COPY --from=cliproxy /usr/local/bin/cli-proxy-api /usr/local/bin/cli-proxy-api

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY tgw-proxy.mjs openai-stream.mjs sanitize-headers.mjs routing-planner.mjs request-executor.mjs request-trace.mjs provider-adapters.mjs protocol-codecs.mjs cline-oauth.mjs usage-observer.mjs cache-observer.mjs quota-cache.mjs ./
COPY gateway-config.mjs ./
COPY route-config.mjs compile-config.mjs gateway.routes.yaml ./
# Provider namespace rewrite, shared by the native lanes and the translated lane.
COPY upstream-model.mjs ./
COPY quota.mjs mistral-subscription-quota.mjs preferences.mjs dashboard.mjs dashboard.html cloudflare-access.mjs model-catalog.mjs copilot-auto.mjs ./
# OpenCode Zen adapter: protocol translation, session pool, gate conditions,
# OAuth credential refresh.
# Anthropic pass-through repair shares the codec it imports.
COPY anthropic-passthrough.mjs anthropic-openai-codec.mjs sse-stream.mjs opencode-zen-gate.mjs opencode-zen-credential.mjs opencode-zen-session.mjs ./
# Copilot-compatible catalog metadata for /v1/models.
COPY model-catalog-metadata.mjs ./
# Copilot SDK state must live on the mounted data volume; credentials are supplied
# through COPILOT_GITHUB_TOKEN (or an interactive device login), never baked in.
ENV COPILOT_AUTO_HOME=/data/copilot-auto
# Routing-preference overrides persist to the mounted /data volume.
ENV ROUTING_PREFERENCES_PATH=/data/gateway.preferences.yaml
COPY entrypoint.sh ./

RUN chmod +x entrypoint.sh

EXPOSE 8080

CMD ["./entrypoint.sh"]
