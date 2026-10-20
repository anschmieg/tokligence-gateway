import assert from "node:assert/strict";
import test from "node:test";
import { createWarpExperimentGuard } from "../warp-experiment-guard.mjs";

function setup(overrides = {}) {
  let clock = Date.parse("2026-10-20T10:00:00Z");
  const env = {
    WARP_TRACE_ENABLED: "1",
    WARP_TRACE_TEST_SECRET: "n".repeat(40),
    WARP_TRACE_MODEL: "warp-exp-model",
    WARP_TRACE_MAX_REQUESTS: "2",
    WARP_TRACE_EXPIRES_AT: "2026-10-20T10:30:00Z",
    ...overrides,
  };
  return {
    guard: createWarpExperimentGuard(env, () => clock),
    advance: ms => { clock += ms; },
  };
}
test("disabled, expired, invalid caps, and long-lived keys fail closed", () => {
  for (const overrides of [
    {WARP_TRACE_ENABLED:"0"}, {WARP_TRACE_TEST_SECRET:"too-short"},
    {WARP_TRACE_MODEL:""}, {WARP_TRACE_EXPIRES_AT:"2026-10-20T09:00:00Z"},
    {WARP_TRACE_EXPIRES_AT:"2026-10-20T12:00:00Z"},
    {WARP_TRACE_MAX_REQUESTS:"0"}, {WARP_TRACE_MAX_REQUESTS:"999"}]) {
    const {guard}=setup(overrides);
    assert.equal(guard.configured,false);
    assert.equal(guard.catalogAllowed(),false);
    assert.equal(guard.reserve({model:"warp-exp-model"},100).allowed,false);
  }
});
test("wrong model, oversized request, invalid output bounds are denied without spending budget", () => {
  const {guard}=setup();
  for (const [payload, bytes, status] of [
    [{model:"other"},10,403],
    [{model:"warp-exp-model"},65537,413],
    [{model:"warp-exp-model",max_tokens:0},100,400],
    [{model:"warp-exp-model",max_completion_tokens:"1"},100,400]
  ]) {
    const r=guard.reserve(payload,bytes);
    assert.equal(r.allowed,false);
    assert.equal(r.status,status);
  }
  assert.equal(guard.remaining,2);
});
test("cap tokens, permit one concurrent, enforce budget and expiry", () => {
  const {guard,advance}=setup();
  const first={model:"warp-exp-model",max_tokens:5000};
  const r=guard.reserve(first,100);
  assert.equal(r.allowed,true);
  assert.equal(first.max_tokens,768);
  assert.equal(guard.reserve({model:"warp-exp-model"},100).status,429);
  r.release();r.release();
  const next={model:"warp-exp-model"};
  const second=guard.reserve(next,100);
  assert.equal(second.allowed,true);
  assert.equal(next.max_tokens,768);
  second.release();
  assert.equal(guard.reserve(next,100).status,429);
  advance(31*60*1000);
  assert.equal(guard.catalogAllowed(),false);
});

test("catalog discovery is limited and time-bound", () => {
  const {guard,advance}=setup();
  for(let i=0;i<12;i++) assert.equal(guard.catalogAllowed(),true);
  assert.equal(guard.catalogAllowed(),false);
  const expired=setup();
  expired.advance(31*60*1000);
  assert.equal(expired.guard.catalogAllowed(),false);
});
