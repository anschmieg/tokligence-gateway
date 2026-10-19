# Modal free compute credits

Modal's **Starter** plan costs $0/month and includes **$30/month of free
compute** — GPU, CPU and memory — billed by the second, with no charge while a
container is scaled to zero. Also included: 1 TiB/month of free network egress,
up to 3 seats, 100 containers and 10 concurrent GPUs.

Verified 2026-10-19 against <https://modal.com/pricing>.

## What the credit does and does not cover

- It covers compute **we run ourselves** on Modal: our own model endpoints,
  evaluation runs, batch jobs, sandboxes.
- It does **not** cover token usage on Modal's Shared Endpoints, which is billed
  from the first request (effective 2026-09-01). Reaching a hosted model through
  a Shared Endpoint is paid usage, not free usage.
- Separate, larger grants exist for startups and for academic or research use.

## Why this matters for the gateway

`gateway.routes.yaml` already configures a `modal` provider lane, so Modal is
reachable without new infrastructure. The $30/month is a standing no-cost budget
for gateway-adjacent compute that would otherwise be paid to a third party.

Candidate uses, none of them evaluated yet:

- Hosting our own small model endpoints, so a lane can be served without a paid
  subscription.
- Running evaluation, replay and prompt-comparison batches against recorded
  traffic instead of on a laptop.
- Sandboxes for the accessibility and computer-use helper work.

## Open questions

- How the budget is consumed by the lane that reaches Modal's *hosted* GLM
  endpoint, and whether that is account compute or shared-endpoint tokens.
- Whether the recurring credit survives a billing-plan change.
