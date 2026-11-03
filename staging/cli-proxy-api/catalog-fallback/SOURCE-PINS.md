# Source and integration pins

This package is a draft; none of these artifacts was installed in production.

## Public metadata

- Repository: https://github.com/anomalyco/models.dev
- Tested data commit: `011577f3bdeab38a8b5a409446ace39d640783d0`.
- Commit-addressed archive: https://codeload.github.com/anomalyco/models.dev/tar.gz/011577f3bdeab38a8b5a409446ace39d640783d0
- Canonical schema: https://github.com/anomalyco/models.dev/blob/011577f3bdeab38a8b5a409446ace39d640783d0/packages/core/src/schema-v2.ts
- Public combined catalog: https://models.dev/catalog.json (HTTP403 from this
  environment; the data-only archive importer was exercised instead).
- The importer records commit, retrieval time and archive SHA256 in each output.
  It reads version2 TOML model/provider data, not the unrelated root `models.json`.
- Models.dev metadata license: MIT; retained in `NOTICE-modelsdev.txt`.
- Imported snapshot: 849 canonical models, 220 provider namespaces. The full
  downloaded dataset is a runtime input and is deliberately not vendored here.
- Target-model coverage is preserved in `evidence/data-readiness.json`. It does
  not establish comparable quality ordering for GLM4.7Flash vs MiniMaxM3.1Flash.

## Native integration

CLIProxyAPI is pinned to upstream v8.0.49. The new `prepare.py` reuses the existing
`prepare_canonical_catalog.py` chain against the reviewed .9 scratch source;
all earlier patch inputs/anchors remain checked there. The draft adds a pure
`internal/catalogfallback` package and adapters to the existing native coordinator,
registry, auth manager and catalog refresh lifecycle. It changes no plugin ABI.

Relevant upstream source seams:
- https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.49/sdk/pluginapi/types.go
- https://github.com/router-for-me/CLIProxyAPI/blob/v8.0.49/internal/pluginhost/adapters.go

The pre-selection plugin router cannot own failed-attempt fallback coordination.
This is custom native policy code, not a claim that stock YAML or an existing
plugin hook implements the behavior. See `ARCHITECTURE.md` for tradeoffs and the
condition under which the native adapter should be retired.

`evidence/draft-input-manifest.json` records the exact draft Go inputs copied
into the verified candidate. The actual-host fixture keeps these existing plugins:
- FreeHub: `927df784dedb67537cb37f61d26adace52ec374922820a8f3c001bfe0981e8b0`.
- OpenCode: `19ee4302f7f96418ba0c59d443c4682ba1972de67d7cf1d687ea4e9004df354b`.

No paid benchmark feed, authenticated enrichment adapter, passive telemetry
collector or inference-based classifier is implemented. No provider inference,
OAuth refresh, account mutation or production deployment was performed.
