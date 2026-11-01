# Provider-scoped dispatch budget patch

Base: mainline CLIProxyAPI8.0.49, commit
`250d598175db61a4e99ac38b9164ed04745754e5`. No Plus backend.

The pinned plugin HTTP API exposes no redirect policy. Its host transport follows
redirects, so plugins alone cannot enforce one physical dispatch. This narrow
host exception refuses redirects for OpenCode/Cline by cloning the request's
client and returning `http.ErrUseLastResponse`. The plugin receives3xx and must
reject it. Provider selection follows the host's logging convention: explicit
provider, then auth provider. Other providers keep mainline behavior. No headers,
TLS profiles, credentials, URLs or bodies are rewritten. This does not address
dispatcher credential retries: the admitted route config still requires retry0
and one credential, and management test endpoints remain outside admission.

Prepare into a NEW separate source directory (never edits input/deploys):

```sh
python3 staging/cli-proxy-api/prepare_provider_patch.py --source /tmp/m2-eval/backend --output /tmp/cliproxy-provider-budget-source
go test staging/cli-proxy-api/patches/provider_dispatch_budget.go staging/cli-proxy-api/patches/provider_dispatch_budget_test.go -race -count=1
```

The named custom test uses only loopback servers and checks physical origin1 /
redirect-target0, unrelated policy and original-client immutability. It does not
retest upstream core behavior. The exported source has an input/output manifest;
parent must build that exact snapshot and perform a quick empty staging smoke
before admitting it. No live credentials are required to prepare/build it.

Rollback: restore the verified stock8.0.49 binary using the owned lifecycle after
stopping only its recorded process. Keep custom provider credentials inactive
until a one-dispatch policy is available. Do not overwrite native UI config.
Retire this patch when mainline offers an equivalent plugin request policy.
