FROM node:22-bookworm-slim AS source
WORKDIR /bridge
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates tar && rm -rf /var/lib/apt/lists/*
COPY scripts/prepare-opencode-native.mjs scripts/prepare-opencode-native.mjs
COPY native/opencode native/opencode
RUN node scripts/prepare-opencode-native.mjs /opencode

FROM oven/bun:1.4.4
WORKDIR /opencode
COPY --from=source /opencode /opencode
RUN bun install --frozen-lockfile --ignore-scripts --filter @opencode/sdk --filter @opencode/core --filter @opencode/server
COPY native/opencode/run.sh /bridge/run.sh
ENV OPENCODE_NATIVE_SOURCE=/opencode OPENCODE_NATIVE_STATE=/state/opencode-native OPENCODE_NATIVE_BIND=0.0.0.0 OPENCODE_NATIVE_PORT=4187
EXPOSE 4187
ENTRYPOINT ["/bridge/run.sh"]
