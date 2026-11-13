# Adversarial review of revised gateway plan

Date:2026-11-01. Scope: architecture/plan review, not implementation acceptance. No provider inference or deployment.

## Requested corrections applied

Mainline router-for-me/CLIProxyAPI remains the backend. Its native upstream admin dashboard is the only planned management UI. The architecture diagram no longer prescribes an OpenCode sidecar. Provider/executor/plugin implementation comes first; helper exceptions require evidence of a real extension limitation. Removed the earlier preference for original-runtime reuse over provider-level implementation.

## Findings and disposition

1. **High — backend/dashboard/T3 version mismatch.** The current embedded backend is7.3.20; the upstream dashboard README now requires8.x, uses/v8/management without v0 fallback, and says a successful v8 configuration write migrates storage. T3 compatibility is not established. Added a pinned version-pair gate, actual hub-contract verification, disabled independent artifact updates and a migration rehearsal. **Open implementation gate:** select and test the pair; do not assume latest works.
2. **High — management actions may bypass dispatch accounting.** A dashboard provider test is documented as running in the browser. UI/provider tests and plugin playgrounds can therefore send uncounted traffic and potentially expose upstream credentials. Added network-path classification and disabling/minimally patching bypass actions before use. **Open implementation gate:** inspect the exact artifact and prove zero unguarded inference; normal management must remain usable.
3. **High — management and extension enforcement remain unproven.** Safe configuration changes, per-provider retry vetoes and durable cooldowns cannot be guaranteed by a generic plugin label. Existing Phase1 path tracing covers this; strengthened it to prevent an unbounded rewrite and to block only affected capabilities. **Open implementation gate:** source-backed extension ordering and physical request-count tests, including reloads and UI/API edits.
4. **Medium — revision hashes do not prevent conflicting writes.** Earlier language risked implying a new custom control plane to obtain atomic writes. Added native-locking-first and explicit constrained-writer fallback; no claim of safe multi-writer behavior without tests. **Open implementation gate:** concurrent write/redeploy tests and documented native limitations.

## Verdict

The revised plan meets the requested product direction. It is ready for the inventory/source-evaluation phases, not credentialed deployment or migration. The four implementation gates above are unknowns to resolve with bounded evidence, not reasons to choose another backend or build a second proxy. Existing live cooldowns remain binding. No claim of request parity, quota resolution or working hub compatibility follows from this review.

Primary evidence: https://github.com/router-for-me/Cli-Proxy-API-Management-Center (README, version/API requirements, upgrade behavior and browser provider-test note).
