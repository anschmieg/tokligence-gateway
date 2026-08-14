import test from "node:test";
import assert from "node:assert/strict";
import { modelAllowedByCatalog } from "../model-catalog.mjs";

const openrouter = {
  id: "openrouter",
  catalog: {
    zero_price_only: true,
    paid_allowlist: ["qwen/qwen3.7-flash"],
  },
};

test("OpenRouter catalog keeps zero-price models even without a free suffix", () => {
  assert.equal(modelAllowedByCatalog(openrouter, {
    id: "google/lyria-3-pro-preview",
    pricing: { prompt: "0", completion: "0" },
  }), true);
});

test("OpenRouter catalog retains only configured paid exceptions", () => {
  assert.equal(modelAllowedByCatalog(openrouter, {
    id: "qwen/qwen3.7-flash",
    pricing: { prompt: "0.00000003", completion: "0.00000013" },
  }), true);
  assert.equal(modelAllowedByCatalog(openrouter, {
    id: "old/paid-model",
    pricing: { prompt: "0.1", completion: "0.2" },
  }), false);
});

test("OpenCode Zen catalog exposes only models explicitly marked free", () => {
  const zen = { id: "opencode-zen", catalog: { id_suffixes: ["-free"] } };
  assert.equal(modelAllowedByCatalog(zen, { id: "deepseek-v4-flash-free" }), true);
  assert.equal(modelAllowedByCatalog(zen, { id: "gpt-5.6-terra" }), false);
});

test("hidden providers do not enter the catalog", () => {
  assert.equal(modelAllowedByCatalog({ id: "opencode-go", catalog: { visible: false } }, {
    id: "deepseek-v4-pro",
  }), false);
});
