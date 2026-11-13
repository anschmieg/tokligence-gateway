# Existing OpenCode gateway implementations, November 1

The working Ubuntu inference server is **2.0.32**. The upgraded client executable is2.2.5, but the service registration and successful09:41 session both record2.0.32. Do not restart it merely to simplify comparison. Staging native runtime remains2.1.4. Saved OAuth email/org/server match; actual grant/runtime configuration remains unmatched.

## CLIProxyAPI

- [Stock README](https://github.com/router-for-me/CLIProxyAPI): generic OpenAI-compatible upstreams are configurable. This is not evidence of dedicated native OpenCode OAuth/session/refresh support.
- [Issue6018](https://github.com/router-for-me/CLIProxyAPI/issues/6018): contributor advertises a separate cpa-zen build. Maintainer explicitly distinguishes its specialized handling from stock. Contributor claims are not independent verification, and the issue concerns403 free-tier identity errors rather than our429.
- [Session mapper](https://github.com/ahoo/cpa-plugin-opencode-session-mapper): forwards stable conversation identifiers. Its README and [troubleshooting](https://github.com/ahoo/cpa-plugin-opencode-session-mapper/blob/main/docs/troubleshooting.md) explicitly say it does not transform bodies/protocols or grant quota/free eligibility. Its cited successful requests belong to a different gateway.
- [opencode2api PR1](https://github.com/ahoo/opencode2api/pull/1): separate gateway reports successful anonymous free-model calls through /inference, removing fake tool stubs and legacy affinity aliases. These are dated, author-reported anonymous403 findings, not proof about authenticated2.x OAuth429 or our current provider configuration. Do not copy speculative identity headers or retry another auth lane after rejection.
- [opencode-zen-server](https://github.com/nennneko5787/opencode-zen-server): another proxy with catalog-driven API-family selection. Its existence supports comparing implementations, not assuming current authenticated access works.

## Architectural consequence

Use these projects as offline references for endpoint selection, explicit authentication precedence, session propagation, and native output/tool handling. Keep the actual native core responsible for session identities and authentication. Compare against the confirmed2.0.32 server, not the upgraded client label. No alternative gateway was installed or given credentials. No live probe was made during this research; the existing rejection/cooldown and disabled schedule remain unchanged. Plugin identity remains unknown because the privacy filter suppressed its reference; do not conclude it caused success.
