---
description: Get or change this session's gateway billing policy
argument-hint: "[free|sub|paid|toggle|get]"
---

Use the installed `routing_client.py` helper identified by
`GATEWAY_ROUTING_HELPER`, with the existing `NOTHING_GATEWAY_SESSION`,
`NOTHING_GATEWAY_PROFILE` and `NOTHING_API_KEY` environment. Never print keys.

Argument: `$ARGUMENTS`. Accept only empty, free, sub, paid, toggle or get.
Empty and toggle cycle FREE → SUB → PAID → FREE. Other values explicitly set
that policy; get reads it. Invoke the helper with the validated single action
argument using the local command tool. Do not interpolate arbitrary user text
into a shell command. Report the returned policy/profile; if control fails,
report failure and keep the prior policy. Never change provider accounts or
client model/base URL as a substitute. No inference request is needed.
