# OpenCode Zen completion checkpoint

User authorized autonomous completion, staging deployments, bounded free-model tests and recurring continuation on October 27. Antigravity was explicitly corrected to **OpenCode Zen free models**. Do not change unrelated providers or the original root checkout. No subagents.

Recurring T3 task: `scheduled-task:command:mcp:9c2e80ed-cdd2-4b4b-a6e3-26ba3d67cea9:schedule-task:opencode-zen-autonomous-20261027-v1`, every 15 minutes, same thread. Check for active work before starting anything. Disable after completion, or if no useful authorized work remains without an external change; explain the exact blocker.

## Acceptance evidence

1. Wire/codec/fault/lifecycle regressions, full tests, lint and native SDK typecheck.
2. Real Claude Code through gateway/native runtime against a synthetic provider: long prompts/responses, tools, parallel results, errors, cancellation and actual reasoning-bearing continuation.
3. Bounded live free-model comparison and live Claude Code/tools/long/reasoning matrix. Missing reasoning is untested, never passed. Do not run three costly copies of the live matrix: these are three independent verification layers.

Layers 1 and 2 have passed; layer 3 remains incomplete. See README for exact scope and limits. Do not claim 100% confidence, byte-for-byte full CLI parity, or live success from fixture tests.

## Current investigation

- Successful user CLI: official 1.18.32 on hermes, saved `opencode/glm-5.3-flash-free` session, no provider credentials/accounts/org/environment key. Source selects built-in public key at `https://opencode.ai/inference/openai/v1`.
- Staging: native source 2.1.4 with secondary OAuth; first beam-free request Oct27 00:05 returned FreeUsageLimitError429 reset Oct28 00UTC. No more OAuth probes before reset. Original timer disabled. This does not establish quota scope/cause.
- First isolated official public beam-free invocation on VPS died SIGKILL with no output. User cgroup limit1GiB, cumulative oom_kill2; attribution unproven without baseline. Staging worker was absent and restored.
- Controlled repeat completed: only recorded staging services stopped; official CLI used fresh credential-free HOME/XDG directories, no plugins or tool permissions, 90-second deadline. It timed out with zero events and no quota indication; oom_kill stayed2 before/after. Staging was restored in finally. Safe result persisted at `/home/agent/tokligence-staging/public-probe-result.json`. Do not blindly repeat: investigate CLI cold startup offline with preserved private diagnostics before another inference attempt. No claim that this reached inference.
- Added explicit native `OPENCODE_NATIVE_AUTH_MODE=public` support, default still OAuth, no automatic fallback. Public mode forbids seeds/auth overrides, requires zero credentials and a fresh independently marked state before host startup. Existing OAuth state cannot be reused. This is being verified offline; staging ownership/mode is unchanged.

## Guardrails

Staging only, SSH `ssh -F /home/t3/.ssh/fra-agent.conf fra-agent`; root `/home/agent/tokligence-staging`, localhost4187/4190. Never print private env files/tokens. Secondary OAuth remains exclusively staging; primary production untouched. Never restore production `secondary-oauth.json`, duplicate refresh owners, unlink a live lock, or change account/IP to bypass rejection. Official public access may be tested in a separate empty profile; do not mix credentials.

No paid models, automatic model fallback, retry storms, or repeated probes after quota/auth/abuse rejection. Record lane/model cooldown and cause before another scheduled turn. One bounded diagnostic invocation per unresolved hypothesis; do useful offline work while live access is blocked. Do not broaden Claude tool/file permissions. Restart only recorded staging PIDs after checking command ownership, never unrelated user processes. Preserve report provenance; do not rerun inference just to regenerate a historical report.
