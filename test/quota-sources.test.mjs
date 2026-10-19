import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  probeClineOauth,
  probeMiniMax,
  probeMistral,
  probeOpenRouter,
} from "../quota.mjs";

async function withJsonServer(handler, fn) {
  const server = http.createServer(async (req, res) => {
    try {
      await handler(req, res);
    } catch (error) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(baseUrl);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("OpenRouter quota uses limit_remaining from /key when present", async () => {
  await withJsonServer((req, res) => {
    assert.equal(req.url, "/api/v1/key");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { usage: 7, limit: 20, limit_remaining: 13, is_free_tier: false } }));
  }, async (baseUrl) => {
    const result = await probeOpenRouter("key", `${baseUrl}/api/v1`);
    assert.equal(result.available, true);
    assert.equal(result.used, 7);
    assert.equal(result.limit, 20);
    assert.equal(result.detail.limit_remaining, 13);
    assert.equal(result.percentUsed, 35);
  });
});

test("MiniMax quota probes token plan remains endpoint", async () => {
  await withJsonServer((req, res) => {
    assert.equal(req.url, "/v1/token_plan/remains");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: { current_interval_usage_count: 12345, total: 50000, interval: "monthly" } }));
  }, async (baseUrl) => {
    const result = await probeMiniMax("sub-key", baseUrl);
    assert.equal(result.available, true);
    assert.equal(result.source, "api");
    assert.equal(result.used, null);
    assert.equal(result.limit, 50000);
    assert.equal(result.limitKind, "balance");
    assert.equal(result.unit, "tokens");
    assert.equal(result.detail.remaining_tokens, 12345);
    assert.equal(result.detail.interval, "monthly");
  });
});

test("Mistral uses Admin API usage and spend-limit when admin key is configured", async () => {
  const seen = [];
  await withJsonServer((req, res) => {
    seen.push(req.url);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (req.url.startsWith("/v1/admin/usage")) {
      res.end(JSON.stringify({ total: 12.5, currency: "USD", month: 9, year: 2026 }));
      return;
    }
    if (req.url === "/v1/admin/spend-limit") {
      res.end(JSON.stringify({ limit: 40, currency: "USD" }));
      return;
    }
    if (req.url === "/v1/admin/rate-limit") {
      res.end(JSON.stringify({ requests_per_second: 10, tokens_limits_by_model: [{ model: "mistral-large-latest", tokens_per_minute: 200000, tokens_per_month: 5000000 }] }));
      return;
    }
    res.end(JSON.stringify({ data: [] }));
  }, async (baseUrl) => {
    const result = await probeMistral("model-key", `${baseUrl}/v1`, { adminApiKey: "admin-key", now: new Date("2026-09-02T12:00:00Z"), mistralObservedRateLimits: { remaining: "tokens=1200", observed_at: "2026-09-02T12:00:00.000Z" } });
    assert.equal(result.available, true);
    assert.equal(result.used, 12.5);
    assert.equal(result.limit, 40);
    assert.equal(result.limitKind, "finite");
    assert.equal(result.percentUsed, 31.25);
    assert.equal(result.detail.rate_limits.requests_per_second, 10);
    assert.equal(result.detail.quota_signals[0].label, "Unofficial Vibe subscription quota");
    assert.equal(result.detail.quota_signals[0].status, "unconfigured");
    assert.deepEqual(result.detail.observed_rate_limits, { remaining: "tokens=1200", observed_at: "2026-09-02T12:00:00.000Z" });
    assert.deepEqual(result.detail.rate_limits.tokens_limits_by_model, [{ model: "mistral-large-latest", tokens_per_minute: 200000, tokens_per_month: 5000000 }]);
    assert.deepEqual(seen, ["/v1/admin/usage?month=9&year=2026", "/v1/admin/spend-limit", "/v1/admin/rate-limit"]);
  });
});

test("Mistral quota keeps unofficial subscription percentage separate from Admin billing", async () => {
  const result = await probeMistral(null, "https://api.mistral.ai/v1", {
    mistralSubscriptionProbe: async () => ({ id: "mistral-vibe-monthly", label: "Unofficial Vibe subscription quota", source: "unofficial-console", status: "fresh", percentUsed: 42.5, resetAt: "2026-11-01T00:00:00.000Z" }),
  });
  assert.equal(result.used, undefined);
  assert.equal(result.percentUsed, undefined);
  assert.equal(result.detail.quota_signals[0].percentUsed, 42.5);
  assert.equal(result.detail.quota_signals[0].source, "unofficial-console");
});

test("Cline OAuth quota uses account balance/usages when adapter exposes it", async () => {
  const adapter = {
    async accountUsage() {
      return {
        user: { id: "u_1", email: "a@example.test" },
        balance: { balance: 4200 },
        usageTransactions: [{ cost: 12 }, { cost: 8 }],
      };
    },
  };
  const result = await probeClineOauth({}, { clineOAuth: adapter });
  assert.equal(result.available, true);
  assert.equal(result.account, "a@example.test");
  assert.equal(result.limitKind, "balance");
  assert.equal(result.detail.balance_remaining_cents, 4200);
  assert.equal(result.detail.transaction_count, 2);
});
