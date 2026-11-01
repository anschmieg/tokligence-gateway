# Working VPS reference, November 1

The user supplied two identical read-only inspections from the working `ubuntu`
shell on `personal`. This is the same machine reached by `fra-agent`, but a
different Unix profile. No inference was requested by either inspection.

## Established evidence

- `ses_e69be2426ffemndjU4cCW5nKtB`, created 2026-11-01T08:37:40.963Z,
  records version **2.0.32**, provider `opencode`, model `beam-free`, finish
  `stop`, no recorded error. Another Beam success appears at 08:33:59Z.
- The unqualified `say hi` command used OpenRouter's `particle-ai/particle-1`;
  that command is not Zen evidence. The explicit Beam command is Zen evidence.
- Two saved OpenCode OAuth credentials exist; exactly one is marked active.
- An environment API key and an API auth-file entry also exist. Both are
  non-public, and their values differ. Values were not disclosed.
- PATH selects a script referring to `HOME` and `OPENCODE2_BINARY`. The script
  was not executed by the corrected inspector. The inspected home ELF's
  `--version` output was not recognized. The successful session's version is
  evidence about that session, not proof of the current wrapper target's hash.
- Staging has one active OAuth credential, with organization and Console-server
  metadata present. The user subsequently confirmed the working profile uses the same account
  email as staging. Organization equality and specific Console credential
  equivalence remain unverified. Do not copy credentials to compare them.

## Source-backed credential selection

Reviewed upstream tag `v2.0.32`, rather than assuming that the 2.1 behavior applies:

1. [Credential.list](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/credential.ts)
   sorts by active flag, creation time and ID, ascending.
2. [resolveConnections / connection.active](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/integration.ts)
   reverses saved credentials, appends environment connections, and selects the
   first connection. A valid active saved OAuth credential therefore precedes
   `OPENCODE_API_KEY` in the standard resolver.
3. [ModelResolver](https://github.com/anomalyco/opencode/blob/v2.0.32/packages/core/src/model-resolver.ts)
   resolves the selected integration connection before constructing the runtime
   model.

Consequently, the key's presence does not explain this success. The standard
2.0.32 path selects stored OAuth for the reported profile. A wrapper override,
plugin modification, historical credential change or different effective profile
has not been excluded by observing the current database. This is a source-backed
selection inference, not a captured Authorization header from the successful turn.

Source SHA-256 values, downloaded read-only from the upstream tag:

| File | SHA-256 |
| --- | --- |
| integration.ts | 766c3cc7c939041d84ecf35a35bda413e16b266b7839631cce3fd6cec7cabb43 |
| credential.ts | c20bcc7e9a0d3c816e6ec1e7513ec3c2d03561c6bf43a86c6a82b6704b2cf84d |
| model-resolver.ts | 38c94cd764651115b5ba715f09c14af748c35fba53ded2ff613850781a810167 |
| plugin/provider/opencode.ts | e51d4a2357e08bbb669a3a2707efeb12f7908c0ad123cdf9de69b53bbe3e742a |

## Relevant version differences

Compared the actual 2.1.4 staging provider source with upstream 2.0.32:

- Both perform authenticated `/api/v2/config` discovery and derive authorization
  and optional organization headers from the resolved credential.
- 2.1.4 normalizes old `console.opencode.ai` credential metadata to its default
  Console server; 2.0.32 uses the stored server directly.
- 2.1.4 changes polling and coalesces config checks after 401/403, updates variant
  normalization and adds hosted voice handling.

These are real differences, not established causes of inference 429s. Neither
version parity nor use of the same machine proves equal account, organization,
server-discovered endpoint or quota scope. No version/header impersonation or
account switch is warranted by this evidence.

## Current operational state

Both recorded staging PIDs were absent when inspected. No diagnostic runner was
active. With the existing diagnostic OS lease held, the ledger had no in-progress
entry and the worker descriptor lock was available. Restored only the two owned
services using their existing launchers/configuration. Both health endpoints
returned 200, the worker lock is held, the production secondary credential path
remains absent, and the probe ledger bytes are unchanged. No diagnostic inference
was sent. Native startup may perform its normal discovery/refresh requests.

The Oct31 staging 429 reset on Nov1 at 00:00 UTC. It is historical evidence for
that modified 2.1.4/staging-credential request, not a current global outage or a
matched rejection of the working ubuntu CLI. Existing reports and consumed IDs
remain untouched. No new live plan is admitted and the timer remains disabled.

Next comparison must resolve account/organization and actual executable/profile
identity before treating a rejection as evidence about gateway request parity.
Do not solve this mismatch by importing the working user's credential or silently
changing the staging auth mode. Existing offline/synthetic verification remains
valid for its stated 2.1.4 scope; successful live acceptance remains incomplete.

## Prepared scope-only comparison

`compare-profile-scope.py` selects the saved connection using native active/newest
ordering and reads only credential type plus email/orgID/server metadata. It
reports equality booleans against staging metadata digests, never token fields or
raw organization identifiers. Missing metadata is unknown, not a match. This is
not evidence about a historical request header or wrapper/plugin overrides.

Run Python with `-I` to prevent the old neighboring `inspect.py` helper from
shadowing the standard-library module; the Python3.14 staging self-comparison
passes in isolated mode. Regression tests include privacy, native ordering, scope
mismatch, missing fields, database byte preservation and the shadowing case.
