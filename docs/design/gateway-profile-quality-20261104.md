# Profile defaults: quality refinement, 2026-11-04

The previous chat/coding defaults both preferred Nemotron 3.5 Lightning because
its route had passed live acceptance. That established connectivity, not the right
quality target. The profile defaults now separate task preference from transport
acceptance and spending permission.

- **chat → `nemotron-3-ultra-550b-a55b`**. NVIDIA describes Ultra as a general,
  conversational/reasoning model and publishes instruction-following and reasoning
  evaluations. It is a better-supported quality target for the current verified
  free catalog than making a small throughput-oriented model the first choice.
  This is an operator default, not a measured claim that users find it warmest.
  [NVIDIA model card](https://build.nvidia.com/nvidia/nemotron-3-ultra-550b-a55b/modelcard).
- **coding → `glm-5.3-flash`**. The first-party card and current Models.dev data
  contain coding/agent results, including Terminal-Bench and DeepSWE. Those results
  are effort/harness-specific; the gateway neither forces benchmark settings nor
  promises their scores at a provider's serving settings.
  [Z.ai model card](https://huggingface.co/zai-org/GLM-5.3-Flash).
- Lightning remains available to the existing compatibility/similarity fallback
  policy. It receives no first-choice preference based on its prior live pass.

MiniMax M3.1 Flash remains a relevant alternative: its first-party publication
reports strong software-engineering results. The live DB currently has its model
record but no benchmark rows. We do not turn that missing coverage into a claim
that MiniMax is weak, or insert incomparable first-party numbers into a fabricated
universal ranking. Its eligible explicit routes remain available; automatic
alternatives continue using current exact-source/task evidence and confidence.
[MiniMax release](https://www.minimax.io/blog/minimax-m31f).

Read-only inventory found 201 registered models with some positive free route,
but only seven chat and three coding entries survived the previous source/task
curation rules. The live cache was commit
`2c96b72db042256faeb06990851c8e343e9cb0be`, validated 2026-11-04 06:00:12 UTC.
The inventory also found **zero** verified account allowance receipts. Native
Codex login therefore does not authorize included/SUB inference by itself; no
receipt, paid allowance, account or quarantine is fabricated or changed here.

## Behavioral correction

The current configured preferred model participates in profile discovery even
when exact-source benchmark coverage is incomplete, subject to current route
capabilities/availability. It appears first and is marked `profile_preferred`.
Its reason explicitly says operator/profile preference, rather than pretending
it has validated benchmark coverage. Ordinary alternatives retain evidence gates.
The response discloses `preferred_model` and `default_billing_policy` at the root.
Max picker size cannot accidentally exclude the profile's viable preference.

The preference never bypasses a context/modality/capability check. A concrete
model supplied through the profile URL still takes precedence over the profile's
configured default. Source disappearance, cooldowns and repricing are still checked
at each request; fallback stays anchored to the original requested/default model.
FREE/SUB/PAID rules, state portability, stream commitment and native selection
remain unchanged. No prompt/personality rewrite or automatic provider probe is added.

This is a supported default refinement, not a fresh provider/model A/B evaluation
or a universal subjective quality leaderboard. Exact artifact, tests and rollout
outcome are recorded separately in the checkpoint and evidence directory.
