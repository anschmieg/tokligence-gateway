#!/usr/bin/env python3
"""Prepare a NEW staged source tree of Free Model Hub for the tokligence host.

Read-only against the inputs. Writes only into ``--output`` (must not exist).

Input : the local pinned clone of the public upstream repository
        (default ``/tmp/free-model-hub-reference-20261102``), verified to
        point at the pinned HEAD ``refs/heads/main`` commit.
Output: a fresh copy of the pinned tree (minus ``.git``) plus this staging's
        minimal adoption patches, applied by exact anchored edits, plus an
        output manifest (``build/prepare-manifest.json``) recording inputs,
        edits and digests for the parent's review and reproducible build.

No network, no build, no test, no credentials: the parent executes git/go.

Usage:
    python3 prepare_free_model_hub.py --source /tmp/free-model-hub-reference-20261102 \
                                      --output /tmp/free-model-hub-tokligence-build
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tarfile
import tempfile
import sys
from pathlib import Path

STAGING_DIR = Path(__file__).resolve().parent
PATCH_DIR = STAGING_DIR / "patches"

# Source of record. Verify: git clone https://github.com/Yousha-dev/free-model-hub
PIN_HEAD = "4d025efe8046af70327d80f75c5bd5ac6b4505af"

SHARED_SOURCES = [
    "/tmp/free-model-hub-reference-20261102",  # pinned upstream clone
    "/tmp/m2-eval/backend",                    # pinned host8.0.49 (schema reference only)
    "/tmp/cliproxy-cloudflare-alpha-source",   # deployed-host patch source (seam reference only)
]

CATALOG_FILES = ['internal/core/helpers.go', 'internal/core/protocol.go', 'internal/vendors/openaicompat/models.go', 'internal/vendors/openaicompat/adapter.go', 'internal/admin/catalog.go', 'internal/admin/canonical_aliases.go', 'internal/admin/canonical_aliases_test.go', 'internal/vendors/openaicompat/catalog_metadata_test.go']

# --- Anchored edits -------------------------------------------------------
# Every entry is applied with an exact expected occurrence count. The script
# fails closed when an anchor is missing or ambiguous; the staged output is
# never rewritten in place afterwards (re-prepare deletes only the output).

EDITS = [
    {"id":"generation-method-not-tool-capability-test","file":"internal/core/protocol_test.go", "find":'!slices.Contains(withTools.SupportedGenerationMethods, "tool_calls")', "replace":'!slices.Contains(withTools.SupportedGenerationMethods, "generateContent")',"why":"Gemini operation and tool parameters are separate declarations."},
    {"id":"cached-generation-method-test","file":"internal/admin/catalog_test.go", "find":'!slices.Contains(info.SupportedGenerationMethods, "tool_calls")', "replace":'!slices.Contains(info.SupportedGenerationMethods, "generateContent")',"why":"Rehydrated tools are parameters, not generation methods."},
    {"id":"leading-vendor-before-account-label","file":"internal/core/registry.go",
     "why":"Saved Cline filename contained a GitHub label; explicit vendor prefixes must beat embedded label matches.",
     "find":"\t\tfor _, id := range ids {\n\t\t\tif FileNameMatchesConvention(base, id) {",
     "replace":"\t\tfor _, id := range ids {\n\t\t\tif fileNameHasVendorPrefix(base, id) { return r.byID[id], true }\n\t\t}\n\t\tfor _, id := range ids {\n\t\t\tif FileNameMatchesConvention(base, id) {"},
    {"id":"zai-retire-undocumented-free-test-id","file":"internal/vendors/openaicompat/openaicompat_test.go",
     "why":"Adjust the upstream test to the explicit current-pricing allowlist, excluding undocumented glm-4-flash-250414.",
     "find":"got := filterModels(models, FilterFlash, false)\n\tif len(got) != 3 {",
     "replace":"got := filterModels(models, FilterFlash, false)\n\tif len(got) != 2 {"},
    {"id":"zai-explicit-free-models","file":"internal/vendors/openaicompat/models.go",
     "why":"Official pricing charges for GLM5.3Flash; only explicit documented zero-price IDs belong in this free lane.",
     "find":'regexp.MustCompile(`-flash($|-)`)',
     "replace":'regexp.MustCompile(`^(glm-4\\.7-flash|glm-4\\.5-flash|glm-4\\.6v-flash)$`)'},
    {"id":"zai-documented-free-catalog","file":"internal/vendors/openaicompat/adapter.go",
     "why":"Supplement documented free IDs omitted by an otherwise successful authenticated model catalog.",
     "find":"models := filterModels(listed, a.provider.Filter, showPaid)",
     "replace":"models := filterModels(listed, a.provider.Filter, showPaid)\n\tif a.provider.Filter == FilterFlash { models = completeZaiFreeCatalog(models) }"},
    {"id":"structured-stream-error-status","file":"internal/app/executor.go",
     "why":"Preserve upstream quota/auth HTTP status through native schema10 stream close.",
     "find":"closeStream(callbackID, streamID, streamFailureMessage(errForward))",
     "replace":"closeStreamFailure(callbackID, streamID, errForward)"},
    {
        "id": "native-host-auth-id-retains-extension",
        "file": "internal/app/authprovider.go",
        "why": "Native v8 indexes saved files by relative filename including .json; preserve that identity to avoid duplicate management entries.",
        "find": 'id := strings.TrimSuffix(fileName, ".json")',
        "replace": 'id := strings.TrimSpace(fileName)',
    },
    {
        "id": "core-registry-parked-field",
        "file": "internal/core/registry.go",
        "why": "Vendor admission needs per-registry parking state (registry_admission.go).",
        "find": (
            "type Registry struct {\n"
            "\tmu    sync.RWMutex\n"
            "\torder []string\n"
            "\tbyID  map[string]Vendor\n"
            "}"
        ),
        "replace": (
            "type Registry struct {\n"
            "\tmu    sync.RWMutex\n"
            "\torder []string\n"
            "\tbyID  map[string]Vendor\n"
            "\t// tokligence staging: vendors withheld by the vendor-admission patch\n"
            "\t// (registry_admission.go) are parked, not dropped; a later reconfigure\n"
            "\t// can admit them again without re-registration or host restart.\n"
            "\tparked      map[string]Vendor\n"
            "\tparkedOrder []string\n"
            "}"
        ),
    },
    {
        "id": "core-registry-parked-init",
        "file": "internal/core/registry.go",
        "why": "Initialize the admission parking state.",
        "find": (
            "func NewRegistry() *Registry {\n"
            "\treturn &Registry{byID: map[string]Vendor{}}\n"
            "}"
        ),
        "replace": (
            "func NewRegistry() *Registry {\n"
            "\treturn & Registry{byID: map[string]Vendor{}, parked: map[string]Vendor{}}\n"
            "}"
        ),
    },
    {
        "id": "app-keyless-default-off",
        "file": "internal/app/keyless.go",
        "why": (
            "Keyless auto-accounts default OFF in this build: the anonymous OpenCode"
            " Zen public lane currently returns 429 (probe_opencode_once.py ledger),"
            " so no public credential may be created at boot."
        ),
        "find": "\tif !admin.ParseBool(cfg.Raw[KeylessAccountsKey], true) {\n",
        "replace": (
            "\t// tokligence staging: keyless auto-accounts default OFF in this build.\n"
            "\t// The anonymous OpenCode Zen public lane currently returns 429 (see\n"
            "\t// probe_opencode_once.py); set keyless_accounts: true explicitly to opt in.\n"
            "\tif !admin.ParseBool(cfg.Raw[KeylessAccountsKey], false) {\n"
        ),
    },
    {
        "id": "app-applyconfig-admission-hook",
        "file": "internal/app/config.go",
        "why": "Apply vendor admission on every config application (register + reconfigure).",
        "find": (
            "\ta.models.RefreshFromState()\n"
            "\ta.configureVendors(cfg)\n"
            "\treturn nil\n"
            "}"
        ),
        "replace": (
            "\ta.applyVendorAdmission(cfg)\n"
            "\ta.models.RefreshFromState()\n"
            "\ta.configureVendors(cfg)\n"
            "\treturn nil\n"
            "}"
        ),
    },
    {
        "id": "app-taskconfig-project-keepalive",
        "file": "internal/app/config.go",
        "why": "Project keepalive_enabled into the tasks engine configuration.",
        "find": (
            "\treturn tasks.Config{\n"
            "\t\tEnabledRealms: cfg.EnabledRealms,\n"
            "\t}"
        ),
        "replace": (
            "\treturn tasks.Config{\n"
            "\t\tEnabledRealms: cfg.EnabledRealms,\n"
            "\t\t// tokligence staging: config-owned scheduler switch\n"
            "\t\t// (default true upstream; the deployment sets false).\n"
            "\t\tKeepaliveEnabled: cfg.KeepaliveEnabled,\n"
            "\t}"
        ),
    },
    {
        "id": "app-configfields-declare-new-keys",
        "file": "internal/app/main.go",
        "why": "Declare the deployment keys in the plugin's ConfigFields contract.",
        "find": (
            "\t\t{Name: \"log_to_file\", Type: pluginapi.ConfigFieldTypeBoolean, "
            "Description: \"Whether to write logs to <state_dir>/logs.\"},\n"
            "\t}"
        ),
        "replace": (
            "\t\t{Name: \"log_to_file\", Type: pluginapi.ConfigFieldTypeBoolean, "
            "Description: \"Whether to write logs to <state_dir>/logs.\"},\n"
            "\n"
            "\t\t{Name: \"keyless_accounts\", Type: pluginapi.ConfigFieldTypeBoolean, "
            "Description: \"Create keyless free-pool accounts automatically. Default false in this build (the anonymous OpenCode Zen lane currently returns 429).\"},\n"
            "\t\t{Name: \"keepalive_enabled\", Type: pluginapi.ConfigFieldTypeBoolean, "
            "Description: \"Run the daily token keepalive scheduler. Default true upstream; set false when the host's native refresh must stay the sole token refresher.\"},\n"
            "\t\t{Name: \"allowed_vendors\", Type: pluginapi.ConfigFieldTypeString, "
            "Description: \"Strict allowlist of vendor IDs kept active (example: kilo,github,nvidia,groq). Empty keeps every vendor (upstream behavior).\"},\n"
            "\t\t{Name: \"blocked_vendors\", Type: pluginapi.ConfigFieldTypeString, "
            "Description: \"Denylist of vendor IDs (example: opencodezen,opencodego,openrouter). Applied in addition to allowed_vendors.\"},\n"
            "\t\t{Name: \"console_keyless\", Type: pluginapi.ConfigFieldTypeBoolean, "
            "Description: \"Serve the console in same-origin keyless mode (management authentication owned by the host's /admin alias access seam).\"},\n"
            "\t\t{Name: \"console_management_base\", Type: pluginapi.ConfigFieldTypeString, "
            "Description: \"Same-origin URL prefix the console prepends to management calls (example: /admin). Empty keeps default paths.\"},\n"
            "\t}"
        ),
    },
    {
        "id": "tasks-config-keepalive-field",
        "file": "internal/tasks/config.go",
        "why": "Carry the scheduler switch inside the projected tasks config.",
        "find": (
            "type Config struct {\n"
            "\t// EnabledRealms are the enabled realms (cn / global).\n"
            "\tEnabledRealms []string\n"
            "}"
        ),
        "replace": (
            "type Config struct {\n"
            "\t// EnabledRealms are the enabled realms (cn / global).\n"
            "\tEnabledRealms []string\n"
            "\t// tokligence staging: keepalive_enabled=false parks the scheduler loop;\n"
            "\t// projected from plugins.configs.free-model-hub.keepalive_enabled\n"
            "\t// (default true upstream; deployment sets false).\n"
            "\tKeepaliveEnabled bool\n"
            "}"
        ),
    },
    {
        "id": "tasks-engine-idle-branch",
        "file": "internal/tasks/engine.go",
        "why": (
            "keepalive_enabled=false parks the wake-up loop without removing the"
            " engine; a reconfigure carrying true can re-enable via Poke."
        ),
        "find": (
            "\tfor {\n"
            "\t\tnext := NextWake(s.deps.Now(), s.KeepaliveHours())\n"
        ),
        "replace": (
            "\tfor {\n"
            "\t\t// tokligence staging: keepalive_enabled=false parks the loop. The\n"
            "\t\t// host's native refresh path stays the sole token refresher; the\n"
            "\t\t// console's manual POST /keepalive button still works. Reconfiguration\n"
            "\t\t// re-enables via Poke without a process restart.\n"
            "\t\tif !s.deps.Config().KeepaliveEnabled {\n"
            "\t\t\tlogger.Info(\"keepalive scheduler idle: disabled by configuration (keepalive_enabled=false); host refresh remains the sole token refresher\")\n"
            "\t\t\tselect {\n"
            "\t\t\tcase <-ctx.Done():\n"
            "\t\t\t\treturn\n"
            "\t\t\tcase <-s.pokeCh:\n"
            "\t\t\t}\n"
            "\t\t\tcontinue\n"
            "\t\t}\n"
            "\t\tnext := NextWake(s.deps.Now(), s.KeepaliveHours())\n"
        ),
    },
    {
        "id": "tasks-engine-status-enabled",
        "file": "internal/tasks/engine.go",
        "why": "Status must be honest about the disabled state (console title text).",
        "find": (
            "\treturn map[string]any{\n"
            "\t\t\"running\":         running,\n"
            "\t\t\"keepalive_hours\": hours,\n"
            "\t\t\"next_at\":         NextWake(s.deps.Now(), hours).Format(time.RFC3339),\n"
            "\t}"
        ),
        "replace": (
            "\treturn map[string]any{\n"
            "\t\t\"running\":           running,\n"
            "\t\t\"keepalive_hours\":    hours,\n"
            "\t\t\"keepalive_enabled\": s.deps.Config().KeepaliveEnabled,\n"
            "\t\t\"next_at\":            NextWake(s.deps.Now(), hours).Format(time.RFC3339),\n"
            "\t}"
        ),
    },
    {
        "id": "admin-config-struct-fields",
        "file": "internal/admin/config.go",
        "why": "Carry the new configuration keys in PluginConfig.",
        "find": (
            "\t// LogToFile when true writes logs to <StateDir>/logs.\n"
            "\tLogToFile bool\n"
        ),
        "replace": (
            "\t// LogToFile when true writes logs to <StateDir>/logs.\n"
            "\tLogToFile bool\n"
            "\n"
            "\t// tokligence staging deployment keys (all default to upstream behavior):\n"
            "\t// AllowedVendors is a strict vendor-ID allowlist (empty = no filter).\n"
            "\tAllowedVendors []string\n"
            "\t// BlockedVendors excludes vendor IDs on top of AllowedVendors.\n"
            "\tBlockedVendors []string\n"
            "\t// KeepaliveEnabled switches the daily token keepalive scheduler.\n"
            "\tKeepaliveEnabled bool\n"
            "\t// ConsoleKeyless enables the same-origin keyless console mode.\n"
            "\tConsoleKeyless bool\n"
            "\t// ConsoleManagementBase is the validated same-origin URL prefix the\n"
            "\t// console prepends to management calls (e.g. \"/admin\").\n"
            "\tConsoleManagementBase string\n"
        ),
    },
    {
        "id": "admin-config-listvalued-keys",
        "file": "internal/admin/config.go",
        "why": "Admission lists accept YAML list syntax like the existing list keys.",
        "find": (
            "var listValuedConfigKeys = map[string]bool{\n"
            "\t\"enabled_realms\":  true,\n"
            "\t\"extra_models\":    true,\n"
            "\t\"disabled_models\": true,\n"
            "}"
        ),
        "replace": (
            "var listValuedConfigKeys = map[string]bool{\n"
            "\t\"enabled_realms\":  true,\n"
            "\t\"extra_models\":    true,\n"
            "\t\"disabled_models\": true,\n"
            "\t// tokligence staging: vendor admission lists.\n"
            "\t\"allowed_vendors\": true,\n"
            "\t\"blocked_vendors\": true,\n"
            "}"
        ),
    },
    {
        "id": "admin-config-defaults-keepalive",
        "file": "internal/admin/config.go",
        "why": "Structural default must preserve the upstream keepalive default (true).",
        "find": (
            "\t\tLogLevel:      DefaultLogLevel,\n"
            "\t\tPromptMode:    PromptModePassThrough,\n"
            "\t\tModelNameTag:  ModelNameTagOff,\n"
            "\t}"
        ),
        "replace": (
            "\t\tLogLevel:      DefaultLogLevel,\n"
            "\t\tPromptMode:    PromptModePassThrough,\n"
            "\t\tModelNameTag:  ModelNameTagOff,\n"
            "\t\t// tokligence staging: upstream-compatible default; deployment opts\n"
            "\t\t// out via plugins.configs.free-model-hub.keepalive_enabled: false.\n"
            "\t\tKeepaliveEnabled: true,\n"
            "\t}"
        ),
    },
    {
        "id": "admin-config-cases-admission",
        "file": "internal/admin/config.go",
        "why": "Parse allowed_vendors / blocked_vendors.",
        "find": (
            "\tcase \"state_dir\":\n"
            "\t\tif trimmed := strings.TrimSpace(value); trimmed != \"\" {\n"
        ),
        "replace": (
            "\t// tokligence staging: vendor admission.\n"
            "\tcase \"allowed_vendors\":\n"
            "\t\tcfg.AllowedVendors = SplitList(stripInlineList(value))\n"
            "\tcase \"blocked_vendors\":\n"
            "\t\tcfg.BlockedVendors = SplitList(stripInlineList(value))\n"
            "\tcase \"state_dir\":\n"
            "\t\tif trimmed := strings.TrimSpace(value); trimmed != \"\" {\n"
        ),
    },
    {
        "id": "admin-config-cases-keepalive-console",
        "file": "internal/admin/config.go",
        "why": "Parse keepalive_enabled and the console same-origin keys.",
        "find": (
            "\tcase \"log_to_file\":\n"
            "\t\tcfg.LogToFile = ParseBool(value, cfg.LogToFile)\n"
        ),
        "replace": (
            "\tcase \"log_to_file\":\n"
            "\t\tcfg.LogToFile = ParseBool(value, cfg.LogToFile)\n"
            "\t// tokligence staging: scheduler switch and console overrides.\n"
            "\tcase \"keepalive_enabled\":\n"
            "\t\tcfg.KeepaliveEnabled = ParseBool(value, cfg.KeepaliveEnabled)\n"
            "\tcase \"console_keyless\":\n"
            "\t\tcfg.ConsoleKeyless = ParseBool(value, cfg.ConsoleKeyless)\n"
            "\tcase \"console_management_base\":\n"
            "\t\tbase, errBase := ValidateManagementBase(value)\n"
            "\t\tif errBase != nil {\n"
            "\t\t\treturn errBase\n"
            "\t\t}\n"
            "\t\tcfg.ConsoleManagementBase = base\n"
        ),
    },
    {
        "id": "admin-console-page-moved",
        "file": "internal/admin/console.go",
        "why": (
            "Hand the page rendering to console_overrides.go, which keeps this"
            " signature and adds the deployment overrides."
        ),
        "find": (
            "// Page returns the console page (injecting the base path of the management API).\n"
            "func Page(basePath string) string {\n"
            "\treturn strings.NewReplacer(\"__BASE__\", basePath).Replace(page)\n"
            "}"
        ),
        "replace": (
            "// Page returns the console page (injecting the base path of the management API).\n"
            "//\n"
            "// tokligence staging: the implementation moved to console_overrides.go,\n"
            "// which keeps this exact signature and adds the same-origin keyless and\n"
            "// management-base overrides (no-op by default, upstream-compatible)."
        ),
    },
    {
        "id": "admin-console-dispatch-calls-override",
        "file": "internal/admin/admin.go",
        "why": "The console resource route must render through the deployment overrides.",
        "find": "return core.OKEnvelope(HTMLResponse(http.StatusOK, []byte(Page(\"/plugins/\"+id.ID))))",
        "replace": "return core.OKEnvelope(HTMLResponse(http.StatusOK, []byte(s.consolePage())))",
    },
    {
        "id": "admin-settings-expose-keepalive-flag",
        "file": "internal/admin/settings.go",
        "why": "Ops can verify the scheduler is disabled from the status payload.",
        "find": "\tsettings := map[string]any{\"keepalive_hours\": s.tasks.KeepaliveHours()}\n",
        "replace": (
            "\tsettings := map[string]any{\n"
            "\t\t\"keepalive_hours\":   s.tasks.KeepaliveHours(),\n"
            "\t\t\"keepalive_enabled\": s.deps.Config().KeepaliveEnabled,\n"
            "\t}\n"
        ),
    },
    {
        "id": "console-html-mgmt-base",
        "file": "internal/admin/console.html",
        "why": "Same-origin management base plus the keyless flag declaration.",
        "find": (
            "  var BASE = \"__BASE__\";\n"
            "  // MGMT is the management API prefix for **this plugin**.\n"
            "  var MGMT = \"/v0/management\" + BASE;"
        ),
        "replace": (
            "  var BASE = \"__BASE__\";\n"
            "  // tokligence staging (console_overrides.go): MGMT_BASE is a validated\n"
            "  // same-origin prefix (\"\" keeps paths unchanged); KEYLESS_SAME_ORIGIN\n"
            "  // lets the page call the management API without a browser credential\n"
            "  // when admin browsers are authenticated at the edge (Cloudflare Access\n"
            "  // behind the same-origin /admin alias). The manual key panel stays\n"
            "  // intact and takes precedence whenever a key is available.\n"
            "  var MGMT_BASE = \"__MGMT_BASE__\";\n"
            "  var KEYLESS_SAME_ORIGIN = __CONSOLE_KEYLESS__;\n"
            "  // MGMT is the management API prefix for **this plugin**.\n"
            "  var MGMT = MGMT_BASE + \"/v0/management\" + BASE;"
        ),
    },
    {
        "id": "console-html-host-mgmt-base",
        "file": "internal/admin/console.html",
        "why": "Host-level management calls (e.g. workbuddy auth URLs) use the same alias.",
        "find": '  var HOST_MGMT = "/v0/management";\n',
        "replace": '  var HOST_MGMT = MGMT_BASE + "/v0/management";\n',
    },
    {
        "id": "console-html-keyless-api",
        "file": "internal/admin/console.html",
        "why": (
            "api() must not refuse to send when no key exists in keyless same-origin"
            " mode; must still attach a key when one is available."
        ),
        "find": (
            "    var key = managementKey();\n"
            "    if (!key) return Promise.resolve(null);\n"
            "    var headers = { \"Content-Type\": \"application/json\" };\n"
            "    headers[\"Authorization\"] = \"Bearer \" + key;"
        ),
        "replace": (
            "    var key = KEYLESS_SAME_ORIGIN ? \"\" : managementKey();\n"
            "    if (!key && !KEYLESS_SAME_ORIGIN) return Promise.resolve(null);\n"
            "    var headers = { \"Content-Type\": \"application/json\" };\n"
            "    if (key) headers[\"Authorization\"] = \"Bearer \" + key;"
        ),
    },
    {
        "id": "zen-foreign-guard",
        "file": "internal/vendors/opencodezen/credential.go",
        "why": (
            "Narrow foreign-auth ownership guard: the native tokligence-opencode"
            " OAuth plugin owns files like opencode.json / opencode-login-*.json"
            " hosted as {\"type\":\"opencode\",\"storage_version\":N,...}; the bare"
            " 'opencode' filename segment must never claim them, and foreign"
            " envelopes are refused explicitly."
        ),
        "find": (
            "func LooksLikeCredential(raw map[string]any, fileName, provider string) bool {\n"
            "\tif core.FileNameMatchesConvention(fileName, VendorID, \"opencode\", \"zen\") {\n"
            "\t\treturn true\n"
            "\t}\n"
        ),
        "replace": (
            "func LooksLikeCredential(raw map[string]any, fileName, provider string) bool {\n"
            "\t// tokligence staging (foreign_guard.go): foreign host-native account\n"
            "\t// files (type \"opencode\"/\"builtin\", storage_version envelope) are\n"
            "\t// never claimed, disabled or rewritten by this plugin.\n"
            "\tif IsForeignCredentialJSON(raw) {\n"
            "\t\treturn false\n"
            "\t}\n"
            "\t// Bare \"opencode\" segment removed from the convention list: the\n"
            "\t// native tokligence-opencode OAuth plugin owns files like opencode.json\n"
            "\t// and opencode-login-*.json, which upstream's convention would swallow\n"
            "\t// silently. Hub-owned files carry the \"opencodezen\" prefix or zen key\n"
            "\t// evidence, so removal only narrows foreign claims.\n"
            "\tif core.FileNameMatchesConvention(fileName, VendorID, \"zen\") {\n"
            "\t\treturn true\n"
            "\t}\n"
        ),
    },
]


# Parent-reviewed additions: use the existing authenticated management route
# for the console. No backend alias change or Coolify restart is required.
EDITS.extend([{'id': 'remove-unused-console-import', 'file': 'internal/admin/console.go', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '\t"strings"\n', 'replace': ''}, {'id': 'authenticated-console-route', 'file': 'internal/admin/admin.go', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '\troutes := []pluginapi.ManagementRoute{\n', 'replace': '\troutes := []pluginapi.ManagementRoute{\n\t\t{Method: "GET", Path: prefix + "/console", Description: "Access-authenticated Free Model Hub console."},\n'}, {'id': 'authenticated-console-handler', 'file': 'internal/admin/admin.go', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': 'case method == http.MethodGet && matchesResourcePath(rpc.Path, id.ID, "/console"):', 'replace': 'case method == http.MethodGet && (matchesResourcePath(rpc.Path, id.ID, "/console") || matchesManagementPath(rpc.Path, id.ID, "/console")):'}, {'id': 'resource-console-enters-access', 'file': 'internal/admin/console.html', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '  var MGMT = MGMT_BASE + "/v0/management" + BASE;', 'replace': '  var MGMT = MGMT_BASE + "/v0/management" + BASE;\n  if (KEYLESS_SAME_ORIGIN && window.location.pathname.indexOf("/v0/resource/") === 0) {\n    window.location.replace(MGMT + "/console");\n    return;\n  }'}, {'id': 'keyless-auth-label', 'file': 'internal/admin/console.html', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '  function authSourceLabel() {\n', 'replace': '  function authSourceLabel() {\n    if (KEYLESS_SAME_ORIGIN) return "Cloudflare Access session";\n'}, {'id': 'keyless-stop-no-key-prompt', 'file': 'internal/admin/console.html', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '    revealKeyInput();\n    setKeyStatus("Management key invalid or missing (HTTP " + status + ")");', 'replace': '    if (KEYLESS_SAME_ORIGIN) {\n      document.getElementById("keyBox").hidden = true;\n      setKeyStatus("Cloudflare Access session expired or denied");\n      banner("err", "Open /dashboard to sign in again. Automatic requests have stopped.");\n      return true;\n    }\n    revealKeyInput();\n    setKeyStatus("Management key invalid or missing (HTTP " + status + ")");'}, {'id': 'keyless-initial-auth-no-key-prompt', 'file': 'internal/admin/console.html', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '      if (!ok) {\n        revealKeyInput();\n        setKeyStatus("No available management key detected:', 'replace': '      if (!ok) {\n        if (KEYLESS_SAME_ORIGIN) {\n          document.getElementById("keyBox").hidden = true;\n          setKeyStatus("Open /dashboard to renew your Cloudflare Access session");\n          return;\n        }\n        revealKeyInput();\n        setKeyStatus("No available management key detected:'}, {'id': 'foreign-provider-ownership', 'file': 'internal/app/authprovider.go', 'why': 'Parent-reviewed keyless console and credential ownership integration.', 'find': '\tvendor, okVendor := a.registry.Resolve(rpc.FileName, rpc.Provider, raw)', 'replace': '\tfor _, owner := range []string{strings.TrimSpace(rpc.Provider), func() string { value, _ := raw["type"].(string); return value }()} {\n\t\tif owner != "" && owner != providerKey {\n\t\t\tif _, known := a.registry.ByID(owner); !known {\n\t\t\t\treturn core.OKEnvelope(pluginapi.AuthParseResponse{Handled: false})\n\t\t\t}\n\t\t}\n\t}\n\tvendor, okVendor := a.registry.Resolve(rpc.FileName, rpc.Provider, raw)'}])

EDITS.extend([{'file': 'internal/hostbridge/http.go',
  'find': 'return &http.Client{Transport: &transport{ctx: ctx}, Timeout: timeout}',
  'id': 'bridge-buffered-no-redirect',
  'replace': 'return &http.Client{Transport: &transport{ctx: ctx}, Timeout: timeout, '
             'CheckRedirect: rejectAutomaticRedirect}',
  'why': 'A redirect would create a second accounted host call.'},
 {'file': 'internal/hostbridge/http.go',
  'find': 'return &http.Client{Transport: &transport{ctx: ctx, stream: true}, Timeout: timeout}',
  'id': 'bridge-stream-no-redirect',
  'replace': 'return &http.Client{Transport: &transport{ctx: ctx, stream: true}, Timeout: timeout, '
             'CheckRedirect: rejectAutomaticRedirect}',
  'why': 'Same one-physical-dispatch policy for streams.'}])

EDITS.extend([{'file': 'internal/admin/config.go',
  'find': '\tlines := normalizeListConfigLines(strings.Split(string(raw), "\\n"))',
  'id': 'standard-host-yaml-parser',
  'replace': '\tcanonical, err := canonicalHostConfig(raw)\n'
             '\tif err != nil { return cfg, err }\n'
             '\tlines := normalizeListConfigLines(strings.Split(string(canonical), "\\n"))',
  'why': 'Native flow-style YAML must not silently discard safety settings.'},
 {'file': 'go.mod',
  'find': 'go 1.26\n',
  'id': 'pin-host-yaml-dependency',
  'replace': 'go 1.26\n\nrequire gopkg.in/yaml.v3 v3.0.1\n',
  'why': 'Same pinned YAML parser as the native host.'}])

# --- New files (copied from staging patches) ------------------------------
NEW_FILES = [
    "internal/core/filename_attribution.go",
    "internal/core/filename_attribution_test.go",
    "internal/app/cline_attribution_test.go",
    "internal/vendors/openaicompat/zai_free_catalog.go",
    "internal/vendors/openaicompat/zai_free_catalog_test.go",
    "internal/app/stream_error.go",
    "internal/app/stream_error_test.go",
    "internal/app/auth_identity_test.go",
    "go.sum",
    "internal/admin/config_yaml.go",
    "internal/admin/config_yaml_test.go",
    "internal/hostbridge/redirect_policy.go",
    "internal/hostbridge/redirect_policy_test.go",
    "internal/core/registry_admission.go",
    "internal/core/registry_admission_test.go",
    "internal/app/vendor_admission.go",
    "internal/app/vendor_admission_test.go",
    "internal/admin/console_overrides.go",
    "internal/admin/console_overrides_test.go",
    "internal/tasks/scheduler_disabled_test.go",
    "internal/vendors/opencodezen/foreign_guard.go",
    "internal/vendors/opencodezen/foreign_guard_test.go",
]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_head(source: Path) -> str:
    head = (source / ".git" / "HEAD").read_text().strip()
    if not head.startswith("ref: "):
        return head
    ref = head.removeprefix("ref: ").strip()
    ref_path = source / ".git" / ref
    return ref_path.read_text().strip()


def fail(message: str) -> "None":
    raise SystemExit(f"prepare_free_model_hub.py: {message}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--source",
        default="/tmp/free-model-hub-reference-20261102",
        help="pinned upstream clone (read-only)",
    )
    parser.add_argument("--output", required=True, help="NEW output directory (must not exist)")
    args = parser.parse_args()

    source = Path(args.source).expanduser().resolve()
    output = Path(args.output).expanduser().resolve()

    if not source.is_dir():
        fail(f"source directory {source} does not exist")
    if output.exists():
        fail(f"output {output} already exists (stage into a NEW directory)")
    for shared in SHARED_SOURCES:
        shared_path = Path(shared)
        if shared_path.exists() and (output == shared_path or shared_path in output.parents or output in shared_path.parents):
            fail(f"output {output} collides with shared input {shared}")
    if STAGING_DIR in output.parents:
        fail(f"output must not be inside the staging directory {STAGING_DIR}")

    head = read_head(source)
    if head != PIN_HEAD:
        fail(f"source HEAD is {head}, want pinned {PIN_HEAD}")
    print(f"pin verified: {head}")

    output.mkdir(parents=True)
    manifest: dict = {
        "upstream": "https://github.com/Yousha-dev/free-model-hub",
        "pin_head": head,
        "source": str(source),
        "output": str(output),
        "input_digests": {},
        "edits": [],
        "new_files": {},
        "output_digests": {},
    }

    copied: dict[str, str] = {}
    # Export the commit itself, never mutable/untracked checkout contents.
    with tempfile.TemporaryFile() as archive:
        subprocess.run(["git", "-C", str(source), "archive", PIN_HEAD], stdout=archive, check=True)
        archive.seek(0)
        with tarfile.open(fileobj=archive) as files:
            files.extractall(output, filter="data")
    for target in sorted(output.rglob("*")):
        if target.is_file():
            copied[str(target.relative_to(output))] = sha256(target)
    if not copied:
        fail("source tree produced no files")
    manifest["input_digests"] = copied

    for edit in EDITS:
        target = output / edit["file"]
        if not target.is_file():
            fail(f"edit {edit['id']}: missing file {edit['file']}")
        text = target.read_text()
        occurrences = text.count(edit["find"])
        if occurrences != 1:
            fail(
                f"edit {edit['id']}: anchor found {occurrences} times in "
                f"{edit['file']} (want exactly 1); refusing to rewrite"
            )
        target.write_text(text.replace(edit["find"], edit["replace"], 1))
        manifest["edits"].append(
            {
                "id": edit["id"],
                "file": edit["file"],
                "why": edit["why"],
                "anchor_sha256": hashlib.sha256(edit["find"].encode()).hexdigest(),
            }
        )
        print(f"edit applied: {edit['id']} -> {edit['file']}")

    for relative in NEW_FILES:
        patch_source = PATCH_DIR / relative
        if not patch_source.is_file():
            fail(f"missing patch file {patch_source}")
        target = output / relative
        shutil.copy2(patch_source, target)
        manifest["new_files"][relative] = sha256(patch_source)
        print(f"file added: {relative}")

    # Reviewed complete-file overlays preserve upstream conventions while correcting
    # metadata and additive alias publication. Applied after prior adoption edits.
    for relative in CATALOG_FILES:
        source_file = PATCH_DIR / relative
        shutil.copyfile(source_file, output / relative)
        manifest["new_files"][relative] = sha256(source_file)

    for path in sorted(output.rglob("*")):
        if path.is_dir():
            continue
        relative_str = str(path.relative_to(output)).replace("\\", "/")
        manifest["output_digests"][relative_str] = sha256(path)

    build_dir = output / "build"
    build_dir.mkdir(exist_ok=True)
    (build_dir / "prepare-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n"
    )
    (build_dir / "PIN").write_text(
        "free-model-hub pinned HEAD: " + head + "\n"
        "host reference: /tmp/m2-eval/backend (schema 10 source of record)\n"
        "deployed-host patch source: /tmp/cliproxy-cloudflare-alpha-source\n"
    )
    print(f"manifest: {build_dir / 'prepare-manifest.json'}")
    print(
        "next (parent, from the staged tree):\n"
        "  1) go test ./internal/core ./internal/app ./internal/tasks ./internal/admin ./internal/vendors/opencodezen -run 'Test(ApplyAdmission|Freehub|Foreign|LooksLikeCredential|Scheduler|Page|ValidateManagementBase|Disabled)' -race -count=1\n"
        "  2) CGO_ENABLED=1 go build -buildmode=c-shared -o free-model-hub.so ."
    )


if __name__ == "__main__":
    main()
