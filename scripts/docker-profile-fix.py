from pathlib import Path

path = Path("Dockerfile")
text = path.read_text()
old = "COPY tgw-proxy.mjs openai-stream.mjs sanitize-headers.mjs smart-router.mjs quota-tracker.mjs routing-profiles.mjs ./\n"
new = "COPY tgw-proxy.mjs openai-stream.mjs sanitize-headers.mjs smart-router.mjs quota-tracker.mjs routing-profiles.mjs routing-planner.mjs request-executor.mjs provider-adapters.mjs protocol-codecs.mjs ./\n"
if old not in text:
    raise SystemExit("expected Dockerfile module COPY line not found")
path.write_text(text.replace(old, new, 1))
