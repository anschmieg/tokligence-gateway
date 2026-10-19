# Warp → Tokligence → PAiOS context provenance lab

**Research only; no deployed recorder.** Source of truth: [Linear D-15](https://linear.app/as-claw/issue/D-15/warp-agent-context-provenance-experiment-via-nothing-gateway), Personal AI OS project.

## Correct gateway

The active gateway is **Tokligence Gateway** (`anschmieg/tokligence-gateway`) at **`https://code.nothing.pink/v1`**. Its public Node.js service is `tgw-proxy.mjs`. The former `anschmieg/ai-gateway` LiteLLM gateway at `ai.nothing.pink` is **legacy** and should not be used for new experiments. Never transplant Python LiteLLM hooks into Tokligence.

## Research objective

Find out why Warp Agent understands terminal context and user intent so well. Correlate:
1. Synthetic shell ground truth: cwd, prior command, stdout/stderr, Git state, project files.
2. Observable Warp context acquisition/actions: shell Blocks, file reads, tool calls; instrument a **disposable test client** when possible.
3. Exact **parsed HTTP ingress** at the user's Tokligence Node proxy: model, roles, tools, synthetic markers and response markers. This is **after Warp's opaque backend**, not necessarily its original internal prompts.
4. Outcome, model/tool iterations, clarifications, token counts, cost and time.

Distinguish observed from inferred from unknown; client-side file reads may not appear as shell commands.

## Staged code

- `warp-context-trace.mjs`: disabled-by-default *marker-only* trace recorder. Does not store arbitrary prompts, responses, authentication headers or secrets. Requires a 0700 directory owned by the gateway process.
- `tgw-proxy.mjs` research changes: dedicated temporary key supported **only when explicitly enabled**, authorized only for `POST /v1/chat/completions` for one designated model plus `GET /v1/models` discovery. The key is stripped before internal forwarding. This is a research branch, not yet a production safety review.
- `test/warp-context-trace.test.mjs`: Node tests for opt-in scopes, metadata-only tracing, streaming, no-op behavior and permission boundaries.
- `research/warp/make_fixture.py`: disposable Git project with unique WARPCTX_* markers and a deliberately failing test.
- `research/warp/shell_probe.zsh`: opt-in shell command observer *only* for the fixture workspace.
- `research/warp/analyze.py`: marker provenance report; does not claim unseen Warp backend actions were absent.

## Deliberately no deployment

For future scoped canary (do not configure on live gateway yet), set:

```text
WARP_TRACE_ENABLED=1
WARP_TRACE_TEST_SECRET=<new high-entropy temporary key, distinct from TOKLIGENCE_AUTH_SECRET>
WARP_TRACE_MODEL=<single explicitly allowed existing test model ID>
WARP_TRACE_DIR=<private 0700 dedicated capture directory>
```

Never use the unrestricted master gateway key in Warp. A dedicated temporary key must be **rate/cost constrained at deployment**, rotated after the run. Warp routes inference through Warp infrastructure; no local or tailnet-only address should be assumed reachable. Select the explicit model, not Auto. Do not record personal terminal sessions. There is **no full-content logging** in this branch: synthetic marker provenance first; a future full-content capability requires explicit synthetic-only consent and a separate safety review.

## Initial experiment

```sh
python3 research/warp/make_fixture.py /tmp/a-new-unique-warp-lab
cd /tmp/a-new-unique-warp-lab/project_WARPCTX_CWD_*
./probe.sh
git status --short
```

Ask Warp: "Why is this test failing? Fix it and verify." Run comparable cases through Warp bundled inference, Warp explicit test model via Nothing, and PAiOS/Moltis where same model is usable. Record what shell knew, what Warp retrieved, what Tokligence saw, and which task result was obtained. Start with a single run, not broad surveillance.

## Acceptance and next agent actions

1. Run `node --test test/warp-context-trace.test.mjs` and `node --check tgw-proxy.mjs` in the research branch, plus existing regression tests if dependencies are available. **Tests not yet certified on deployment**.
2. Review new trial-key path, request parser and outbound stream interception. Prove ordinary gateway requests unchanged and wrong model/key rejected. Add rate/cost caps and timed rollback before any live canary.
3. Capture **synthetic** request and output markers from a dedicated Warp model to a private local store. Confirm which markers reach the model and which don't.
4. Instrument Warp's open-source shell/Block context pipeline; original shell context could be acquired without shell commands.
5. Compare against PAiOS and implement one proven improvement. Update D-15 and clean up test credentials/traces.

No changes to live gateway routing or PAiOS production services are authorized by this research setup.