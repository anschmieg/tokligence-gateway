import assert from "node:assert/strict";
import test from "node:test";

import { calculateDynamicCost, getProviderQuota } from "../quota-tracker.mjs";
import { selectBestProvider, getFallbackProvider } from "../smart-router.mjs";
import { ROUTING_PROFILES, getProfileForTask } from "../routing-profiles.mjs";

test("quota-tracker: calculateDynamicCost with full quota", () => {
  const result = calculateDynamicCost({ remaining: 1.0, total: 1000, used: 0 });
  assert.equal(result.cost, 0);
  assert.equal(result.quota_remaining, 1.0);
});

test("quota-tracker: calculateDynamicCost with 50% quota", () => {
  const result = calculateDynamicCost({ remaining: 0.5, total: 1000, used: 500 });
  assert.equal(result.cost, 50);
  assert.equal(result.quota_remaining, 0.5);
});

test("quota-tracker: calculateDynamicCost with 10% quota", () => {
  const result = calculateDynamicCost({ remaining: 0.1, total: 1000, used: 900 });
  assert.equal(result.cost, 90);
  assert.equal(result.quota_remaining, 0.1);
});

test("quota-tracker: calculateDynamicCost with empty quota", () => {
  const result = calculateDynamicCost({ remaining: 0, total: 1000, used: 1000 });
  assert.equal(result.cost, 100);
  assert.equal(result.quota_remaining, 0);
});

test("quota-tracker: calculateDynamicCost with undefined quota", () => {
  const result = calculateDynamicCost(undefined);
  assert.equal(result.cost, 0);
});

test("routing-profiles: primary profile exists", () => {
  assert.ok(ROUTING_PROFILES.primary);
  assert.equal(ROUTING_PROFILES.primary.name, "Primary (High-Quality)");
  assert.equal(ROUTING_PROFILES.primary.providers.length, 4);
});

test("routing-profiles: auxiliary profiles exist", () => {
  assert.ok(ROUTING_PROFILES.auxiliary);
  assert.ok(ROUTING_PROFILES.auxiliary.compression);
  assert.ok(ROUTING_PROFILES.auxiliary.web_extraction);
  assert.ok(ROUTING_PROFILES.auxiliary.vision);
  assert.ok(ROUTING_PROFILES.auxiliary.default);
});

test("routing-profiles: fallback profile exists", () => {
  assert.ok(ROUTING_PROFILES.fallback);
  assert.equal(ROUTING_PROFILES.fallback.name, "Fallback (Any)");
});

test("routing-profiles: getProfileForTask primary", () => {
  const profile = getProfileForTask("primary");
  assert.equal(profile.name, "Primary (High-Quality)");
});

test("routing-profiles: getProfileForTask auxiliary:compression", () => {
  const profile = getProfileForTask("auxiliary:compression");
  assert.equal(profile.name, "Auxiliary: Compression");
});

test("routing-profiles: getProfileForTask auxiliary:web_extraction", () => {
  const profile = getProfileForTask("auxiliary:web_extraction");
  assert.equal(profile.name, "Auxiliary: Web Extraction");
});

test("routing-profiles: getProfileForTask auxiliary:vision", () => {
  const profile = getProfileForTask("auxiliary:vision");
  assert.equal(profile.name, "Auxiliary: Vision");
});

test("routing-profiles: getProfileForTask unknown falls back to primary", () => {
  const profile = getProfileForTask("unknown");
  assert.equal(profile.name, "Primary (High-Quality)");
});

test("routing-profiles: getProfileForTask auxiliary:unknown falls back to default", () => {
  const profile = getProfileForTask("auxiliary:unknown");
  assert.equal(profile.name, "Auxiliary: Default");
});

test("smart-router: getFallbackProvider excludes specified providers", async () => {
  const fallback = await getFallbackProvider(["mistral", "nvidia"], "primary");
  assert.ok(fallback);
  assert.notEqual(fallback.id, "mistral");
  assert.notEqual(fallback.id, "nvidia");
});

test("smart-router: getFallbackProvider returns null when all excluded", async () => {
  const profile = ROUTING_PROFILES.primary;
  const allProviderIds = profile.providers.map(p => p.id);
  const fallback = await getFallbackProvider(allProviderIds, "primary");
  assert.equal(fallback, null);
});
