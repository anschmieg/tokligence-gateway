import assert from "node:assert/strict";
import test from "node:test";

import { allowedAnthropicBeta, applyAnthropicBetaPolicy } from "../provider-adapters.mjs";

test("Anthropic beta headers are restricted to exact route allow-list entries", () => {
  assert.equal(allowedAnthropicBeta("context-management-2025-06-27, compact-2026-09-04", ["compact-2026-09-04"]), "compact-2026-09-04");
  assert.equal(allowedAnthropicBeta("compact-2026-09-04-extra", ["compact-2026-09-04"]), undefined);
  assert.equal(allowedAnthropicBeta("context-management-2025-06-27", []), undefined);
  assert.equal(allowedAnthropicBeta(undefined, ["compact-2026-09-04"]), undefined);
});

test("paired beta request fields are stripped unless that route admits their beta", () => {
  const body = { model: "claude-test", context_management: { edits: [{ type: "clear_tool_uses_20250919" }] }, compaction: { trigger: { type: "tokens", value: 50000 } } };
  const result = applyAnthropicBetaPolicy(body, "context-management-2025-06-27, compact-2026-09-04", ["compact-2026-09-04"]);
  assert.equal(result.header, "compact-2026-09-04");
  assert.deepEqual(JSON.parse(result.body), { model: "claude-test", compaction: body.compaction });
  assert.equal(body.context_management.edits[0].type, "clear_tool_uses_20250919");
});


test("mutually exclusive Anthropic context editing is removed when summary compaction is present", () => {
  const body = {
    model: "claude-test",
    context_management: { edits: [{ type: "clear_tool_uses_20250919" }] },
    compaction: { type: "summarize" },
  };
  const result = applyAnthropicBetaPolicy(
    body,
    "context-management-2025-06-27, compact-2026-09-04",
    ["context-management-2025-06-27", "compact-2026-09-04"],
  );
  assert.deepEqual(JSON.parse(result.body), { model: "claude-test", compaction: { type: "summarize" } });
  assert.equal(result.header, "context-management-2025-06-27, compact-2026-09-04");
});
