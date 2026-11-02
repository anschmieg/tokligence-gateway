# Isolated native host fixture

`isolated_host_smoke.py` exercises the actual native CLIProxyAPI host and the
exact Free Model Hub and native OpenCode shared libraries supplied by the
parent. This is an integration fixture, not an upstream conformance suite.
It has not been executed by its author; the pending host/plugin candidates
must pass it before a successful integration is claimed.

Requires Linux, Python 3 (stdlib only), `bwrap`, and `/usr/bin/openssl`.
Bubblewrap must support `--unshare-net`; there is no fallback. OpenSSL makes
an ephemeral test CA/certificate inside the sandbox, with SANs for the real
Kilo hostname `api.kilo.ai` and the fake redirect target. Production provider
URLs are unchanged. A CONNECT proxy maps only those two authorities to two
loopback TLS mock servers. Every other CONNECT is denied and fails the smoke.
The host trusts only the fixture CA through `SSL_CERT_FILE` and an empty
`SSL_CERT_DIR`. No caller HOME, credential directory, DNS configuration, proxy
environment, or network environment is inherited. The supplied host and both
libraries are mounted read-only; plugin files are not rebuilt or copied.

The private, new output directory contains only fake credentials, the test
CA/key, host config/state, and sanitized `verdict.json`. All files are private
through umask 077. The fixture never prints tokens, management keys, raw
account data, response bodies, or host logs. Failure evidence reports gate
names, exception classes, counters, namespace tokens, and input hashes.
The supervisor kills the complete bwrap process group on every outcome, with
a 52-second execution deadline and bounded child reap, below 55 seconds.

Required gates:

- Different readable outer/inner network namespace tokens; both plugins
  registered and enabled through authenticated `GET /v8/management/plugins`.
- Authenticated `GET /admin/v0/management/plugins/free-model-hub/console`
  serves `KEYLESS_SAME_ORIGIN = true`, `MGMT_BASE = "/admin"`, the v0 API
  derivation, and no injected fake secret. The console and vendors API return
  401 without a native management key. No backend v8 plugin alias is needed.
- Empty `allowed_vendors` retains login providers including Cline, GitHub,
  and Groq; `opencodezen`, `opencodego`, and `openrouter` are absent. Keepalive
  is disabled, console keyless mode is enabled, and state uses `/work/state`.
- `keyless_accounts: true` creates only `kilo-free.json`. A seeded, disabled,
  enveloped native OpenCode credential (fake tokens, expiry 2050) retains its
  exact source-file hash; no other auth file or native OpenCode model appears.
  The fixture supplies no other vendor credentials and makes no OpenRouter
  inference request. It does not claim live native OpenRouter functionality.
- Kilo catalog GET returns one zero-price free model. The request uses the
  actual published `/v1/models` ID, and one streaming `/v1/chat/completions`
  yields inert fixture text, a stop finish, and `[DONE]`.
- The second caller POST receives a mock 307 to the second mock server.
  The first stream dispatches once, the redirect origin dispatches once, the
  target receives zero requests, and exactly two physical inference POSTs
  occur in total. Startup inference, fanout, retries, unexpected HTTP paths,
  and unapproved CONNECT authorities fail the smoke.

The redirect probe exercises the combined host HTTP bridge and plugin HTTP
client policy: both must prevent following redirects along this path. It does
not independently attribute a failure to one layer. Parent candidate `.5`
must include Free Hub in the host no-redirect policy and the plugin's own
`CheckRedirect` guard; this fixture never patches either implementation.

The parent runs, using the exact pending candidate artifacts and a path that
does not exist (replace all artifact placeholders):

```sh
python3 staging/cli-proxy-api/free-model-hub/testing/isolated_host_smoke.py \
  --binary /absolute/path/to/native-host.5 \
  --plugin /absolute/path/to/free-model-hub.so \
  --opencode-plugin /absolute/path/to/opencode.so \
  --output /tmp/freehub-native-host-smoke-NEW
cat /tmp/freehub-native-host-smoke-NEW/verdict.json
```
