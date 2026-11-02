#!/usr/bin/env python3
"""Prepare a separate pinned mainline source snapshot; never deploy or build."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile

PIN = "250d598175db61a4e99ac38b9164ed04745754e5"
HTTP_SHA = "1fdcc543624398284c48d1600227452457046fe42f7b7830cf020d0c35946f3d"
REL = "internal/pluginhost/http_bridge.go"
ANCHOR = "\tcliproxyexecutor.MarkUpstreamAttempt(ctx)\n\tresp, errDo := client.Do(httpReq)"
REPLACEMENT = """\t// Local provider budget policy: no hidden redirect dispatches.
\tbudgetProvider := strings.TrimSpace(c.provider)
\tif budgetProvider == "" && c.auth != nil {
\t\tbudgetProvider = c.auth.Provider
\t}
\tclient = providerDispatchClient(client, budgetProvider)
\tcliproxyexecutor.MarkUpstreamAttempt(ctx)
\tresp, errDo := client.Do(httpReq)"""


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--unsigned-thinking-compat", action="store_true", help="Opt-in host seam for existing Claude/OpenAI compatibility translator")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    output = args.output.absolute()
    if output.exists() or output.is_symlink():
        parser.error("output must not exist; no in-place patching or forced overwrite")
    # Export the pinned commit, not mutable worktree contents. Verify the exact
    # edited input before creating output. No fetch, checkout, credential reads.
    raw = subprocess.check_output(["git", "-C", str(source), "show", f"{PIN}:{REL}"])
    if digest(raw) != HTTP_SHA or raw.decode().count(ANCHOR) != 1:
        parser.error("pinned source/input mismatch")
    artifacts = Path(__file__).resolve().parent / "patches"
    additions = {}
    for name in ("provider_dispatch_budget.go", "provider_dispatch_budget_test.go"):
        additions[name] = (artifacts / name).read_bytes()
    adapter_rel = "internal/pluginhost/adapters_executors.go"
    adapter_sha = "762e5110cf796765a8db0abf7780536fc309ad422178dc38cc4a492e0adb355c"
    adapter_raw = None
    adapter_anchor = "translated := sdktranslator.TranslateRequestEnvelope(context.Background(), inputRequested, inputFormat, sdktranslator.RequestEnvelope{"
    if args.unsigned_thinking_compat:
        adapter_raw = subprocess.check_output(["git", "-C", str(source), "show", f"{PIN}:{adapter_rel}"])
        if digest(adapter_raw) != adapter_sha or adapter_raw.decode().count(adapter_anchor) != 1:
            parser.error("pinned executor adapter mismatch")
        for name in ("plugin_thinking_compat.go", "plugin_thinking_compat_test.go"):
            additions[name] = (artifacts / name).read_bytes()
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "-C", str(source), "archive", PIN], stdout=archive, check=True)
        archive.seek(0)
        output.mkdir(mode=0o700)
        with tarfile.open(fileobj=archive) as files:
            files.extractall(output, filter="data")
    http_file = output / REL
    if digest(http_file.read_bytes()) != HTTP_SHA:
        raise RuntimeError("exported source mismatch; output not ready")
    patched = raw.decode().replace(ANCHOR, REPLACEMENT).encode()
    http_file.write_bytes(patched)
    for name, body in additions.items():
        target = output / "internal/pluginhost" / name
        if target.exists():
            raise RuntimeError("patch output unexpectedly exists")
        target.write_bytes(body)
    if adapter_raw is not None:
        adapter_patched = adapter_raw.decode().replace(adapter_anchor, "translated := a.translateConfiguredPluginRequest(context.Background(), inputRequested, inputFormat, sdktranslator.RequestEnvelope{").encode()
        (output / adapter_rel).write_bytes(adapter_patched)
    report = {
        "base_commit": PIN,
        "input_http_sha256": HTTP_SHA,
        "patched_http_sha256": digest(patched),
        "additions": {name: digest(body) for name, body in additions.items()},
        "providers": ["opencode", "cline", "freehub"],
        "unsigned_thinking_compat": args.unsigned_thinking_compat,
        "patched_adapter_sha256": digest(adapter_patched) if adapter_raw is not None else None,
        "built": False,
        "deployed": False,
    }
    (output / "provider-budget-manifest.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps({"prepared": str(output), "base_commit": PIN, "deployed": False}))


if __name__ == "__main__":
    main()
