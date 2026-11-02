# Isolated Cline host smoke

Build the reviewed plugin outside the sandbox, then run:

```sh
python3 plugins/cline/testing/isolated_host_smoke.py --binary /tmp/cli-proxy-api-provider-budget --plugin /tmp/cline-reviewed-stream-build.so --output /tmp/cline-host-smoke-example
```

Requires bubblewrap network namespace support; no unsandboxed fallback. Uses
fresh fake credentials/config, an empty private home, loopback mock provider,
and the actual compiled plugin/backend. The outer 56-second process-group
supervisor bounds cleanup on all outcomes. No build/download in the sandbox.

The script imports the reviewed OpenCode test utility definitions (namespace,
startup, HTTP calls and SSE block reconstruction), overrides provider-specific
setup/entry point, and runs no OpenCode profile. It is a test-only dependency.

Exactly three synthetic requests: Chat stream with reasoning; Messages tool
response with original ID/arguments; malformed post-DONE response that must not
emit executable tools or a successful Messages terminal. Zero inference retry.
Private verdict, backend log and response artifacts are saved under --output.

Evidence: /tmp/cline-host-smoke-20261102-a refused at publication (fixture lacked
common plugin enabled flag), zero mock dispatches. Corrected b passed all four
checks, namespace proof and exactly three mock dispatches. This proves the
custom host boundary, not live Cline acceptance, reasoning replay, refresh
ownership handoff, or actual Claude Code behavior.

The earlier child cline-smoke.sh is not admitted: archive/binary hash confusion,
broad kill-0 cleanup, missing namespace/mock server and incomplete assertions.
It was not executed or copied into this branch.
